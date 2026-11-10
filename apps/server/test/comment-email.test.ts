import { env } from "cloudflare:workers";
import { type Member, newId, R } from "@oa/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  COMMENT_UNSUB_PATH,
  signUnsubToken,
  verifyUnsubToken,
} from "../src/email/comment-email.js";
import {
  MAX_COMMENT_EMAILS_PER_RECIPIENT_PER_DAY,
  MAX_EMAILS_PER_RECIPIENT_PER_DAY,
  sendEmail,
} from "../src/email/send.js";
import type { Env } from "../src/env.js";
import { runtimeStub } from "../src/runtime/do.js";
import { publish } from "../src/services/artifacts.js";
import {
  COMMENT_EMAIL_WINDOW_MS,
  emailCommentRecipients,
} from "../src/services/comment-email.js";
import {
  addReply,
  addThread,
  type CommentWho,
} from "../src/services/comments.js";
import { getUser } from "../src/services/users.js";
import { sha256Hex } from "../src/util/crypto.js";
import { api, login } from "./helpers.js";

// #1467: comment emails. Who gets one, the throttle, the cap bucket, the
// opt-out and the unsubscribe token.

const app = createApp();
const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();
const FROM = "noreply@mail.example.com";

type Sent = {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
};
function mailer(fail = false) {
  const sent: Sent[] = [];
  const e = {
    ...E,
    EMAIL_FROM: FROM,
    EMAIL: {
      async send(m: Sent) {
        if (fail) throw new Error("E_SEND_FAILED");
        sent.push(m);
        return { messageId: `m${sent.length}` };
      },
    } as unknown as SendEmail,
  } as Env;
  return { sent, e };
}

type U = { cookie: string; userId: string; member: Member; email: string };
async function mk(prefix: string): Promise<U> {
  const email = `${prefix}-${newId().slice(0, 6).toLowerCase()}-${tag}@x.com`;
  const l = await login(email, "member");
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}
const view = (u: U) => ({ userId: u.userId, short: null, moderator: true });
const person = (u: U): CommentWho => ({ kind: "user", id: u.userId });
const agentOf = (u: U): CommentWho => ({
  kind: "user",
  id: u.userId,
  agent: { name: "Claude Code", version: null },
});
const AFTER = { version: 1 };

async function setup() {
  const owner = await mk("owner");
  const editor = await mk("editor");
  const other = await mk("other");
  const a = await publish(
    E,
    owner.member,
    {
      title: "Doc",
      format: "html",
      content: "<p>The quick brown fox</p>",
    } as never,
    null,
    undefined,
    "create",
  );
  for (const u of [editor, other])
    await api(app, R.shares(a.id), owner.cookie, {
      method: "PUT",
      body: { email: u.email, role: "editor" },
    });
  return { owner, editor, other, id: a.id };
}

const art = (id: string) =>
  ({ id, format: "html", currentVersion: 1 }) as never;
async function thread(
  e: Env,
  id: string,
  who: CommentWho,
  u: U,
  body = "hello",
  after = AFTER,
) {
  return addThread(
    e,
    art(id),
    who,
    view(u),
    { anchor: { kind: "note" }, body },
    { after },
  );
}
const reply = (
  e: Env,
  id: string,
  threadId: string,
  who: CommentWho,
  u: U,
  body = "re",
  after = AFTER,
) => addReply(e, id, threadId, who, view(u), body, {}, { after });

beforeEach(async () => {
  await E.DB.prepare("delete from counters where key like 'email:%'").run();
});

describe("who is emailed", () => {
  it("a new thread emails the owner, not the author; the mail names the app and unsubscribes", async () => {
    const s = await setup();
    const m = mailer();
    await thread(m.e, s.id, person(s.editor), s.editor);
    expect(m.sent.map((x) => x.to)).toEqual([s.owner.email]);
    const mail = m.sent[0] as Sent;
    expect(mail.text).toContain(`/a/${s.id}`);
    expect(mail.text).toContain(COMMENT_UNSUB_PATH);
    expect(mail.headers?.["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
    expect(mail.headers?.["List-Unsubscribe"]).toMatch(
      new RegExp(`^<https?://[^>]+${COMMENT_UNSUB_PATH}\\?t=`),
    );
  });

  it("the author is never emailed, nor the person whose agent wrote it", async () => {
    const s = await setup();
    const m = mailer();
    await thread(m.e, s.id, person(s.owner), s.owner);
    await thread(m.e, s.id, agentOf(s.owner), s.owner);
    expect(m.sent).toEqual([]);
  });

  it("a reply emails earlier commenters, not the author, not people who never commented", async () => {
    const s = await setup();
    const t = await thread(E, s.id, person(s.editor), s.editor);
    await reply(E, s.id, t.id, person(s.other), s.other);
    const m = mailer();
    await reply(m.e, s.id, t.id, person(s.owner), s.owner);
    expect(m.sent.map((x) => x.to).sort()).toEqual(
      [s.editor.email, s.other.email].sort(),
    );
  });

  it("an agent's earlier comment does not make its person a recipient; own agent's reply never mails its person", async () => {
    const s = await setup();
    const t = await thread(E, s.id, agentOf(s.editor), s.editor);
    const m = mailer();
    await reply(m.e, s.id, t.id, person(s.owner), s.owner);
    expect(m.sent).toEqual([]);
    await reply(E, s.id, t.id, person(s.other), s.other);
    await reply(m.e, s.id, t.id, agentOf(s.other), s.other);
    // Only the owner (a person who commented) hears it: not the agent's person, not the editor whose agent wrote the root.
    expect(m.sent.map((x) => x.to)).toEqual([s.owner.email]);
  });

  it("a guest who commented earlier has no address to email", async () => {
    const s = await setup();
    const t = await addThread(
      E,
      art(s.id),
      { kind: "guest", short: "g1", rate: "ip:1", name: "Guest" },
      { userId: null, short: "g1", moderator: false },
      { anchor: { kind: "note" }, body: "hi" },
      {},
    );
    const m = mailer();
    await reply(m.e, s.id, t.id, person(s.owner), s.owner);
    expect(m.sent).toEqual([]);
    // A guest's own thread still tells the owner.
    await addThread(
      m.e,
      art(s.id),
      { kind: "guest", short: "g1", rate: "ip:1", name: "Guest" },
      { userId: null, short: "g1", moderator: false },
      { anchor: { kind: "note" }, body: "again" },
      { after: AFTER },
    );
    expect(m.sent.map((x) => x.to)).toEqual([s.owner.email]);
  });

  it("someone who lost access is not emailed", async () => {
    const s = await setup();
    const t = await thread(E, s.id, person(s.editor), s.editor);
    await E.DB.prepare("delete from shares where artifact_id = ?")
      .bind(s.id)
      .run();
    const m = mailer();
    await reply(m.e, s.id, t.id, person(s.owner), s.owner);
    expect(m.sent).toEqual([]);
  });

  it("someone who turned comment emails off is not emailed; Me shows the flag", async () => {
    const s = await setup();
    const r = await api(app, R.me, s.owner.cookie, {
      method: "PATCH",
      body: { commentEmail: false },
    });
    expect(((await r.json()) as { commentEmail: boolean }).commentEmail).toBe(
      false,
    );
    const m = mailer();
    await thread(m.e, s.id, person(s.editor), s.editor);
    expect(m.sent).toEqual([]);
    const me = (await (await api(app, R.me, s.editor.cookie)).json()) as {
      commentEmail: boolean;
    };
    expect(me.commentEmail).toBe(true);
  });

  it("no mailer configured: the comment is written and nothing is sent", async () => {
    const s = await setup();
    const t = await thread(E, s.id, person(s.editor), s.editor);
    expect(t.id).toBeTruthy();
  });
});

describe("the write survives a failing mailer", () => {
  it("the comment is stored and the throttle slot is given back", async () => {
    const s = await setup();
    const bad = mailer(true);
    const t = await thread(bad.e, s.id, person(s.editor), s.editor);
    expect(t.comments).toHaveLength(1);
    const root = t.comments[0];
    if (!root) throw new Error("no root");
    const good = mailer();
    const n = await emailCommentRecipients(good.e, {
      artifactId: s.id,
      threadId: t.id,
      comment: {
        ...root,
        author: { kind: "user", ref: s.editor.userId },
      } as never,
      reply: false,
    });
    expect(n).toBe(1);
  });
});

describe("the throttle", () => {
  it("one email per (thread, person) per 15 minutes", async () => {
    const s = await setup();
    const t = await thread(E, s.id, person(s.editor), s.editor);
    const root = (await runtimeStub(E, s.id).commentsGet(t.id))
      .comments[0] as never;
    const m = mailer();
    const job = (now: number) => ({
      artifactId: s.id,
      threadId: t.id,
      comment: root,
      reply: false,
      now,
    });
    const t0 = Date.now();
    expect(await emailCommentRecipients(m.e, job(t0))).toBe(1);
    expect(await emailCommentRecipients(m.e, job(t0 + 60_000))).toBe(0);
    expect(
      await emailCommentRecipients(m.e, job(t0 + COMMENT_EMAIL_WINDOW_MS - 1)),
    ).toBe(0);
    expect(
      await emailCommentRecipients(m.e, job(t0 + COMMENT_EMAIL_WINDOW_MS + 1)),
    ).toBe(1);
    expect(m.sent).toHaveLength(2);
    // Another thread is its own throttle.
    const t2 = await thread(E, s.id, person(s.editor), s.editor);
    expect(
      await emailCommentRecipients(m.e, {
        artifactId: s.id,
        threadId: t2.id,
        comment: (await runtimeStub(E, s.id).commentsGet(t2.id))
          .comments[0] as never,
        reply: false,
        now: t0 + 1000,
      }),
    ).toBe(1);
  });
});

describe("the cap bucket", () => {
  const to = `cap-${tag}@x.com`;
  it("comment notices have their own daily limit; invites and codes keep theirs", async () => {
    const m = mailer();
    const render = () => ({ subject: "s", text: "t", html: "<p>t</p>" });
    const comment = () =>
      sendEmail(m.e, null, to, render, { kind: "comment", instance: "x" });
    for (let i = 0; i < MAX_COMMENT_EMAILS_PER_RECIPIENT_PER_DAY; i++)
      expect(await comment()).toBe(true);
    expect(await comment()).toBe(false);
    // The invite/share bucket for the same address is untouched.
    for (let i = 0; i < MAX_EMAILS_PER_RECIPIENT_PER_DAY; i++)
      expect(
        await sendEmail(m.e, `u${i}`, to, render, {
          kind: "invite",
          instance: "x",
        }),
      ).toBe(true);
    // Comment mail never touched sign-in-code counters.
    const codes = await E.DB.prepare(
      "select count(*) as n from counters where key like 'code:%' and key like ?",
    )
      .bind(`%${tag}%`)
      .first<{ n: number }>();
    expect(codes?.n).toBe(0);
  });
});

describe("the unsubscribe token", () => {
  it("verifies, and a tampered, foreign, re-versioned or malformed token does not", async () => {
    const a = await signUnsubToken(E, "user_a");
    const b = await signUnsubToken(E, "user_b");
    expect(await verifyUnsubToken(E, a)).toBe("user_a");
    const [v, , sigA] = a.split(".") as [string, string, string];
    expect(await verifyUnsubToken(E, `${v}.user_b.${sigA}`)).toBeNull();
    expect(
      await verifyUnsubToken(
        E,
        `${a.slice(0, -1)}${a.endsWith("A") ? "B" : "A"}`,
      ),
    ).toBeNull();
    expect(await verifyUnsubToken(E, a.replace(/^v1/, "v2"))).toBeNull();
    expect(await verifyUnsubToken(E, `${b}.x`)).toBeNull();
    expect(await verifyUnsubToken(E, "")).toBeNull();
  });

  const hit = (method: string, path: string, body?: string) =>
    app.fetch(
      new Request(`http://app.localhost${path}`, {
        method,
        headers: body
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {},
        body,
      }),
      E as never,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
  const flag = async (id: string) =>
    (
      await E.DB.prepare("select comment_email as v from users where id = ?")
        .bind(id)
        .first<{ v: number }>()
    )?.v;

  it("GET and POST both turn off that one person's flag, again and again, and say so", async () => {
    const u = await mk("unsub");
    const w = await mk("unsub2");
    const v = await mk("bystander");
    const t = encodeURIComponent(await signUnsubToken(E, u.userId));
    const g = await hit("GET", `${COMMENT_UNSUB_PATH}?t=${t}`);
    expect(g.status).toBe(200);
    expect(await g.text()).toContain("Comment emails are off.");
    expect(await flag(u.userId)).toBe(0);
    // One-click: the token rides the URL, the body is the RFC 8058 line.
    const tw = encodeURIComponent(await signUnsubToken(E, w.userId));
    const p1 = await hit(
      "POST",
      `${COMMENT_UNSUB_PATH}?t=${tw}`,
      "List-Unsubscribe=One-Click",
    );
    expect(p1.status).toBe(200);
    expect(await flag(w.userId)).toBe(0);
    const p2 = await hit("POST", COMMENT_UNSUB_PATH, `t=${t}`);
    expect(p2.status).toBe(200);
    expect(await flag(u.userId)).toBe(0);
    expect(await flag(v.userId)).toBe(1);
  });

  it("a bad token changes nothing", async () => {
    const u = await mk("bad");
    const t = await signUnsubToken(E, u.userId);
    expect((await hit("GET", `${COMMENT_UNSUB_PATH}?t=${t}x`)).status).toBe(
      400,
    );
    expect(
      (await hit("POST", `${COMMENT_UNSUB_PATH}?t=${t}x`, "")).status,
    ).toBe(400);
    expect(await flag(u.userId)).toBe(1);
  });
});

describe("Product's spec: reasons, copy, off pages, left-out count", () => {
  const stored = async (s: Awaited<ReturnType<typeof setup>>, id: string) =>
    (await runtimeStub(E, s.id).commentsGet(id)).comments[0] as never as {
      author: unknown;
      body: string;
    };

  it("ask beats mention beats reply; one email per person per comment, verbatim copy", async () => {
    const s = await setup();
    const t = await thread(
      E,
      s.id,
      person(s.editor),
      s.editor,
      "see https://evil.example/x and www.evil.example",
    );
    const root = (await runtimeStub(E, s.id).commentsGet(t.id))
      .comments[0] as never as Record<string, unknown>;
    const m = mailer();
    const n = await emailCommentRecipients(m.e, {
      artifactId: s.id,
      threadId: t.id,
      comment: {
        ...root,
        author: { kind: "user", ref: s.editor.userId },
        ask: { to: [{ kind: "user", key: s.other.userId }] },
        // A mention names an agent: nobody is emailed for it.
        mentions: [
          { key: "k", name: "n", state: "delivered", owner: s.other.userId },
          { key: "k2", name: "n2", state: "delivered", owner: s.owner.userId },
        ],
      } as never,
      reply: false,
    });
    // The ask tells its person; the owner (new thread) has the thread reason.
    expect(n).toBe(2);
    const toOther = m.sent.find((x) => x.to === s.other.email) as Sent;
    const toOwner = m.sent.find((x) => x.to === s.owner.email) as Sent;
    expect(toOther.subject).toMatch(/asked you a question on Doc$/);
    expect(toOther.text).toContain("Pick an answer on the page:");
    expect(toOther.text).toContain(
      "You're getting this because the question is for you.",
    );
    expect(toOwner.subject).toMatch(/commented on Doc$/);
    expect(toOwner.text).toContain(
      "You're getting this because you own this page.",
    );
    expect(toOther.text).toContain(
      "New replies in this thread for the next 15 minutes stay on the page, with no email.",
    );
    expect(toOther.text).toContain("Change this in Settings: ");
    // The comment's links are not clickable; ours are.
    expect(toOther.text).toContain("https[:]//evil.example/x");
    expect(toOther.text).toContain("www[.]evil.example");
    expect(toOther.html).not.toContain("https://evil");
    void stored;
  });

  it("the person whose agent wrote it is emailed only when asked (an agent's mention emails no one)", async () => {
    const s = await setup();
    const t = await thread(E, s.id, agentOf(s.editor), s.editor);
    const root = (await runtimeStub(E, s.id).commentsGet(t.id))
      .comments[0] as never as Record<string, unknown>;
    const job = (extra: object) => ({
      artifactId: s.id,
      threadId: t.id,
      comment: { ...root, ...extra } as never,
      reply: true,
    });
    const m = mailer();
    expect(await emailCommentRecipients(m.e, job({}))).toBe(0);
    expect(
      await emailCommentRecipients(
        m.e,
        job({
          mentions: [
            { key: "k", name: "n", state: "delivered", owner: s.editor.userId },
          ],
        }),
      ),
    ).toBe(0);
    expect(
      await emailCommentRecipients(
        m.e,
        job({ ask: { to: [{ kind: "user", key: s.editor.userId }] } }),
      ),
    ).toBe(1);
    const mail = m.sent[0] as Sent;
    expect(mail.subject).toContain("Claude Code (");
    expect(mail.subject).toContain("'s agent) asked you a question on Doc");
  });

  it("nothing is sent on a page with comments turned off; the title is cut to 60", async () => {
    const s = await setup();
    await E.DB.prepare("update artifacts set title = ? where id = ?")
      .bind("T".repeat(100), s.id)
      .run();
    const m = mailer();
    await thread(m.e, s.id, person(s.editor), s.editor);
    expect((m.sent[0] as Sent).subject).toContain(`${"T".repeat(59)}…`);
    await E.DB.prepare("update artifacts set comments = 0 where id = ?")
      .bind(s.id)
      .run();
    const m2 = mailer();
    await thread(m2.e, s.id, person(s.editor), s.editor);
    expect(m2.sent).toEqual([]);
  });

  it("excerpt is 300 characters", async () => {
    const s = await setup();
    const m = mailer();
    await thread(m.e, s.id, person(s.editor), s.editor, "x".repeat(500));
    const q = (m.sent[0] as Sent).text.match(/"(x+…?)"/)?.[1] ?? "";
    expect(Array.from(q)).toHaveLength(300);
  });

  it("comments the daily cap left out are counted and named in the next email", async () => {
    const s = await setup();
    const day = new Date().toISOString().slice(0, 10);
    const key = `email:c:to:${await sha256Hex(s.owner.email.toLowerCase())}`;
    await E.DB.prepare(
      "insert into counters (key, n, day) values (?, ?, ?) on conflict (key) do update set n = excluded.n, day = excluded.day",
    )
      .bind(key, MAX_COMMENT_EMAILS_PER_RECIPIENT_PER_DAY, day)
      .run();
    const m = mailer();
    await thread(m.e, s.id, person(s.editor), s.editor);
    await thread(m.e, s.id, person(s.editor), s.editor);
    expect(m.sent).toEqual([]);
    await E.DB.prepare("delete from counters where key = ?").bind(key).run();
    await thread(m.e, s.id, person(s.editor), s.editor);
    expect((m.sent[0] as Sent).text).toContain(
      "2 more comments today weren't emailed. They're all on the page.",
    );
    await thread(m.e, s.id, person(s.editor), s.editor);
    expect((m.sent[1] as Sent).text).not.toContain("more comments today");
  });
});
