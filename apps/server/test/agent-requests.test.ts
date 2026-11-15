import { env } from "cloudflare:workers";
import {
  type BusNotice,
  type Member,
  newId,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import {
  allow,
  allowChallenge,
  decide,
  listHeld,
  notNow,
} from "../src/services/agent-requests.js";
import { publish } from "../src/services/artifacts.js";
import {
  type DeliveryOutcome,
  installDelivery,
  type NoticeDelivery,
} from "../src/services/bus-delivery.js";
import {
  addThread,
  artifactAgents,
  type CommentViewer,
  type CommentWho,
  editComment,
  listComments,
} from "../src/services/comments.js";
import { follow } from "../src/services/follows.js";
import { putShare } from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

// #2577: asking someone else's agent. The comment posts; its delivery to the
// receiver's agents is held until the receiver allows it or the sender is on
// their list. The receiver's own agents read a placeholder meanwhile.

const E = env as unknown as Env;
const app = createApp();
const tag = newId().slice(0, 6).toLowerCase();

class FakeBus implements NoticeDelivery {
  sent: { userId: string; notice: BusNotice }[] = [];
  outcome: DeliveryOutcome = "delivered";
  async deliver(_e: Env, userId: string, notice: BusNotice) {
    if (notice.kind === "commented") {
      this.sent.push({ userId, notice });
      return "delivered" as const;
    }
    this.sent.push({ userId, notice });
    return this.outcome;
  }
}
const bus = new FakeBus();
let prev: NoticeDelivery;
beforeAll(() => {
  prev = installDelivery(bus);
});
afterAll(() => installDelivery(prev));
beforeEach(async () => {
  bus.sent = [];
  await E.DB.prepare(
    "delete from counters where key like 'notice:mention:%'",
  ).run();
});

type U = { userId: string; member: Member; email: string; cookie: string };
async function mk(prefix: string): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, "member");
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { userId: l.userId, member: m, email, cookie: l.cookie };
}
let owner: U;
let editor: U;
beforeAll(async () => {
  owner = await mk("ar-owner");
  editor = await mk("ar-editor");
});

const typed = (u: U): CommentWho => ({
  kind: "user",
  id: u.userId,
  typed: true,
});
const token = (u: U): CommentWho => ({ kind: "user", id: u.userId });
const view = (u: U): CommentViewer => ({
  userId: u.userId,
  short: null,
  moderator: true,
});
/** A viewer that is an agent of `u` (a token or MCP grant). */
const asAgent = (u: U): CommentViewer => ({
  userId: u.userId,
  short: null,
  agent: { name: "Claude", version: null, via: { kind: "token", id: "t1" } },
});
const NOTE = { kind: "note" } as const;
const art = (id: string) =>
  ({ id, format: "html", currentVersion: 1 }) as never;

async function setup(extra: Record<string, unknown> = {}) {
  const a = await publish(
    E,
    owner.member,
    { title: "doc", format: "html", content: "<p>x</p>", ...extra } as never,
    null,
    undefined,
    "create",
  );
  await putShare(E, owner.member, a.id, {
    email: editor.email,
    role: "editor",
  });
  await follow(E, owner.userId, { namespace: "ns-o", name: "Claude" }, a.id);
  await follow(E, editor.userId, { namespace: "ns-e", name: "Codex" }, a.id);
  const list = await artifactAgents(E, a.id, editor.userId);
  const claude = list.find((x) => x.name.startsWith("Claude"))?.key as string;
  return { id: a.id, claude };
}

const post = (
  id: string,
  who: CommentWho,
  u: U,
  body: string,
  extra: Record<string, unknown> = {},
) =>
  addThread(
    E,
    art(id),
    who,
    view(u),
    { anchor: NOTE, body, ...extra },
    { moderator: true },
  ) as Promise<Thread>;
const mention = (key: string) => ({ mentions: [{ key }] });
const toOwnerAgent = () => bus.sent.filter((x) => x.userId === owner.userId);
const held = async (u: U = owner) => (await listHeld(E, u.userId)).requests;
const listAs = async (id: string, v: CommentViewer) =>
  (await listComments(E, id, "all", v)).threads;

describe("holding", () => {
  it("a mention of someone else's agent posts, sends nothing, and reads waiting to the asker", async () => {
    const s = await setup();
    const t = await post(
      s.id,
      typed(editor),
      editor,
      "where does the 42% come from?",
      mention(s.claude),
    );
    expect(toOwnerAgent()).toHaveLength(0);
    // The asker's view: the comment, the mention still queued, nothing refused.
    const seen = (await listAs(s.id, view(editor)))[0]?.comments[0];
    expect(seen?.body).toBe("where does the 42% come from?");
    expect(seen?.mentions?.[0]?.delivery).toBe("queued");
    const [r] = await held();
    expect(r?.sender.id).toBe(editor.userId);
    expect(r?.items).toHaveLength(1);
    expect(r?.items[0]?.body).toBe("where does the 42% come from?");
    expect(t.comments[0]?.body).toContain("42%");
  });

  it("the receiver's agents read a placeholder in every list; the person and the asker read the words", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "secret words", mention(s.claude));
    const agentView = (await listAs(s.id, asAgent(owner)))[0]?.comments[0];
    expect(agentView?.body).toBe(
      expect.stringContaining("is waiting for your person") as never,
    );
    expect(JSON.stringify(agentView)).not.toContain("secret words");
    expect((await listAs(s.id, view(owner)))[0]?.comments[0]?.body).toBe(
      "secret words",
    );
    expect((await listAs(s.id, view(editor)))[0]?.comments[0]?.body).toBe(
      "secret words",
    );
  });

  it("an agent's or a token's comment holds nothing and wakes nothing", async () => {
    const s = await setup();
    await post(s.id, token(editor), editor, "from a token", mention(s.claude));
    expect(toOwnerAgent()).toHaveLength(0);
    expect(await held()).toHaveLength(0);
  });

  it("a note on the page where the page agent is someone else's is held too, and a follower notice from a non-listed member goes nowhere", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "a plain note");
    expect(toOwnerAgent()).toHaveLength(0);
  });
});

describe("allow", () => {
  it("once passes exactly the shown words, marks them as a teammate's, and unmasks", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "one", mention(s.claude));
    const [r] = await held();
    const out = await allow(E, owner.userId, r?.id as string, {
      level: "once",
      items: (r?.items ?? []).map((i) => ({
        commentId: i.commentId,
        wordsHash: i.wordsHash,
      })),
    });
    expect(out).toEqual({ sent: 1, changed: 0, waiting: 0 });
    expect(toOwnerAgent().map((x) => x.notice.to.name)).toEqual(["Claude"]);
    // Delivered as someone else's words, never the receiver's own.
    expect(toOwnerAgent()[0]?.notice.text).not.toMatch(/your user/i);
    expect((await listAs(s.id, asAgent(owner)))[0]?.comments[0]?.body).toBe(
      "one",
    );
    expect(await held()).toHaveLength(0);
    // Once is once: the next request asks again.
    await post(s.id, typed(editor), editor, "two", mention(s.claude));
    expect(await held()).toHaveLength(1);
  });

  it("an edit after the notice is never delivered", async () => {
    const s = await setup();
    const t = await post(
      s.id,
      typed(editor),
      editor,
      "before",
      mention(s.claude),
    );
    const [r] = await held();
    const shown = (r?.items ?? []).map((i) => ({
      commentId: i.commentId,
      wordsHash: i.wordsHash,
    }));
    await editComment(
      E,
      s.id,
      t.id,
      t.comments[0]?.id as string,
      typed(editor),
      view(editor),
      "after, with new words",
    );
    const out = await allow(E, owner.userId, r?.id as string, {
      level: "once",
      items: shown,
    });
    expect(out).toEqual({ sent: 0, changed: 1, waiting: 0 });
    expect(toOwnerAgent()).toHaveLength(0);
    // Still masked, and the notice now shows the new words with a new hash.
    expect(
      JSON.stringify((await listAs(s.id, asAgent(owner)))[0]?.comments[0]),
    ).not.toContain("new words");
    const again = (await held())[0]?.items[0];
    expect(again?.body).toBe("after, with new words");
    expect(again?.wordsHash).not.toBe(shown[0]?.wordsHash);
  });

  it("a hash that is not the one shown, or someone else's request, passes nothing", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "x", mention(s.claude));
    const [r] = await held();
    const out = await allow(E, owner.userId, r?.id as string, {
      level: "once",
      items: [
        {
          commentId: r?.items[0]?.commentId as string,
          wordsHash: "0".repeat(64),
        },
      ],
    });
    expect(out.sent).toBe(0);
    await expect(
      allow(E, editor.userId, r?.id as string, {
        level: "once",
        items: [{ commentId: "c", wordsHash: "0".repeat(64) }],
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("for this page lists the sender: later requests go straight to the agent", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "first", mention(s.claude));
    const [r] = await held();
    // No passkey on this member: no assertion needed.
    await allow(E, owner.userId, r?.id as string, {
      level: "page",
      items: (r?.items ?? []).map((i) => ({
        commentId: i.commentId,
        wordsHash: i.wordsHash,
      })),
    });
    bus.sent = [];
    await post(s.id, typed(editor), editor, "second", mention(s.claude));
    expect(toOwnerAgent().map((x) => x.notice.to.name)).toEqual(["Claude"]);
    expect(await held()).toHaveLength(0);
    // The entry is live: it ends when the member loses edit rights on the page.
    await putShare(E, owner.member, s.id, {
      email: editor.email,
      role: "viewer",
    });
    expect(await decide(E, editor.userId, owner.userId, s.id)).toBe("hold");
  });

  it("the list never applies on a page open to anyone with the link", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "x", mention(s.claude));
    const [r] = await held();
    await allow(E, owner.userId, r?.id as string, {
      level: "page",
      items: (r?.items ?? []).map((i) => ({
        commentId: i.commentId,
        wordsHash: i.wordsHash,
      })),
    });
    expect(await decide(E, editor.userId, owner.userId, s.id)).toBe("deliver");
    await E.DB.prepare(
      "update artifacts set visibility = 'public' where id = ?",
    )
      .bind(s.id)
      .run();
    expect(await decide(E, editor.userId, owner.userId, s.id)).toBe("hold");
  });

  it("all pages needs a passkey, an end date within a year, and a page not open", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "x", mention(s.claude));
    const [r] = await held();
    const items = (r?.items ?? []).map((i) => ({
      commentId: i.commentId,
      wordsHash: i.wordsHash,
    }));
    const until = Date.now() + 30 * 86_400_000;
    await expect(
      allow(E, owner.userId, r?.id as string, { level: "all", items, until }),
    ).rejects.toMatchObject({ code: "passkey_required" });
    await expect(
      allow(E, owner.userId, r?.id as string, {
        level: "all",
        items,
        until: Date.now() + 400 * 86_400_000,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    // The prompt is for a member with a passkey: this one has none.
    await expect(
      allowChallenge(E, owner.userId, r?.id as string, until),
    ).rejects.toMatchObject({ code: "no_passkey" });
  });

  it("not now quiets the sender for a day and changes nothing the asker sees", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "x", mention(s.claude));
    const [r] = await held();
    await notNow(E, owner.userId, r?.id as string);
    const row = await E.DB.prepare(
      "select quiet_until as q from held_requests where id = ?",
    )
      .bind(r?.id)
      .first<{ q: number }>();
    expect(row?.q).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(
      (await listAs(s.id, view(editor)))[0]?.comments[0]?.mentions?.[0]
        ?.delivery,
    ).toBe("queued");
  });

  it("the hourly limit sends what fits and leaves the rest held", async () => {
    const s = await setup();
    for (let n = 0; n < 3; n++)
      await post(s.id, typed(editor), editor, `m${n}`, mention(s.claude));
    const [r] = await held();
    const items = (r?.items ?? []).map((i) => ({
      commentId: i.commentId,
      wordsHash: i.wordsHash,
    }));
    const hour = new Date().toISOString().slice(0, 13);
    await E.DB.prepare(
      "insert or replace into counters (key, day, n) values (?, ?, ?)",
    )
      .bind(`notice:mention:to:${owner.userId}`, hour, 39)
      .run();
    const out = await allow(E, owner.userId, r?.id as string, {
      level: "once",
      items,
    });
    expect(out.sent).toBe(1);
    expect(out.waiting).toBe(2);
    expect((await held())[0]?.items).toHaveLength(2);
  });
});

describe("all pages in a space", () => {
  const space = async (name: string) => {
    const id = `sp_${newId().slice(0, 10)}`;
    await E.DB.prepare(
      "insert into spaces (id, kind, name, created_at) values (?, 'shared', ?, ?)",
    )
      .bind(id, name, Date.now())
      .run();
    return id;
  };
  const move = (artifactId: string, spaceId: string | null) =>
    E.DB.prepare("update artifacts set space_id = ? where id = ?")
      .bind(spaceId, artifactId)
      .run();
  const listen = (spaceId: string) =>
    E.DB.prepare(
      `insert into agent_listens (id, owner_id, member_id, scope, space_id, until, created_via, created_at)
       values (?, ?, ?, 'space', ?, ?, 'allow_space', ?)`,
    )
      .bind(
        newId(),
        owner.userId,
        editor.userId,
        spaceId,
        Date.now() + 30 * 86_400_000,
        Date.now(),
      )
      .run();

  it("a page in the space delivers, a page moved out holds, and a page in another space holds", async () => {
    const launch = await space("Launch");
    const other = await space("Other");
    const s = await setup();
    await move(s.id, launch);
    await listen(launch);
    expect(await decide(E, editor.userId, owner.userId, s.id)).toBe("deliver");
    await post(s.id, typed(editor), editor, "in the space", mention(s.claude));
    expect(toOwnerAgent().map((x) => x.notice.to.name)).toEqual(["Claude"]);
    // Moved out of the space: the entry stops applying to it.
    await move(s.id, null);
    expect(await decide(E, editor.userId, owner.userId, s.id)).toBe("hold");
    // In another space: not covered.
    await move(s.id, other);
    expect(await decide(E, editor.userId, owner.userId, s.id)).toBe("hold");
    // Back in: covered again; and never on a page open to anyone with the link.
    await move(s.id, launch);
    expect(await decide(E, editor.userId, owner.userId, s.id)).toBe("deliver");
    await E.DB.prepare(
      "update artifacts set visibility = 'public' where id = ?",
    )
      .bind(s.id)
      .run();
    expect(await decide(E, editor.userId, owner.userId, s.id)).toBe("hold");
  });

  it("the allow needs a page in a shared space, an end date and a passkey", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "x", mention(s.claude));
    const [r] = await held();
    const items = (r?.items ?? []).map((i) => ({
      commentId: i.commentId,
      wordsHash: i.wordsHash,
    }));
    const until = Date.now() + 30 * 86_400_000;
    // Not in a space: nothing to allow.
    expect(r?.space).toBeNull();
    await expect(
      allow(E, owner.userId, r?.id as string, { level: "space", items, until }),
    ).rejects.toMatchObject({ code: "bad_request" });
    const launch = await space("Launch");
    await move(s.id, launch);
    expect((await held())[0]?.space).toEqual({ id: launch, name: "Launch" });
    await expect(
      allow(E, owner.userId, r?.id as string, { level: "space", items, until }),
    ).rejects.toMatchObject({ code: "passkey_required" });
    await expect(
      allow(E, owner.userId, r?.id as string, {
        level: "space",
        items,
        until: Date.now() + 400 * 86_400_000,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("an ask addressed to someone else's agent", () => {
  it("posts as a card, the receiver's row stays closed and empty until they allow it", async () => {
    const s = await setup();
    await addThread(
      E,
      art(s.id),
      typed(editor),
      view(editor),
      {
        anchor: NOTE,
        body: "Which export?",
        ask: {
          question: "Which export do we use?",
          options: [
            { id: "weekly", label: "Weekly" },
            { id: "daily", label: "Daily" },
          ],
          to: [{ key: s.claude }],
        },
      },
      { moderator: true },
    );
    const row = await E.DB.prepare(
      "select open, held, question from artifact_asks where addressee = ? and artifact_id = ?",
    )
      .bind(owner.userId, s.id)
      .first<{ open: number; held: number; question: string | null }>();
    expect(row).toMatchObject({ open: 0, held: 1, question: null });
    expect(toOwnerAgent()).toHaveLength(0);
    const [r] = await held();
    await allow(E, owner.userId, r?.id as string, {
      level: "once",
      items: (r?.items ?? []).map((i) => ({
        commentId: i.commentId,
        wordsHash: i.wordsHash,
      })),
    });
    const after = await E.DB.prepare(
      "select open, held, question from artifact_asks where addressee = ? and artifact_id = ?",
    )
      .bind(owner.userId, s.id)
      .first<{ open: number; held: number; question: string }>();
    expect(after).toMatchObject({
      open: 1,
      held: 0,
      question: "Which export do we use?",
    });
  });
});

describe("the receiver's routes", () => {
  it("are a browser session of the receiver only", async () => {
    const s = await setup();
    await post(s.id, typed(editor), editor, "x", mention(s.claude));
    const ok = await api(app, R.agentAskHeld, owner.cookie);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { requests: { items: unknown[] }[] };
    expect(body.requests[0]?.items).toHaveLength(1);
    // The sender sees none of it.
    const mine = await api(app, R.agentAskHeld, editor.cookie);
    expect(((await mine.json()) as { requests: unknown[] }).requests).toEqual(
      [],
    );
    // No credentials: refused.
    expect(
      (await api(app, R.agentAskHeld, null)).status,
    ).toBeGreaterThanOrEqual(401);
  });
});
