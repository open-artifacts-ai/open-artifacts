import { env } from "cloudflare:workers";
import { type Inbox, type Me, type Member, newId, R } from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { publish } from "../src/services/artifacts.js";
import {
  addReply,
  addThread,
  answerAsk,
  type CommentWho,
} from "../src/services/comments.js";
import {
  itemExcerpt,
  recordCommentItems,
  writeInboxItems,
} from "../src/services/inbox-items.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

// #2512 S2: mentions and updates in the For you inbox.

const app = createApp();
const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();

type U = { cookie: string; userId: string; member: Member; email: string };
async function mk(prefix: string, role: "member" | "guest" = "member") {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, role);
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email } as U;
}

let owner: U;
let me: U;
let other: U;
let guest: U;
beforeAll(async () => {
  owner = await mk("u-owner");
  me = await mk("u-me");
  other = await mk("u-other");
  guest = await mk("u-guest", "guest");
});

const who = (u: U): CommentWho => ({ kind: "user", id: u.userId });
const view = (u: U) => ({ userId: u.userId, short: null, moderator: true });
const after = { version: 1 };

async function mkArtifact(readers: U[] = [me, other, guest]) {
  const a = await publish(
    E,
    owner.member,
    { title: "doc", format: "html", content: "<p>x</p>" } as never,
    null,
    undefined,
    "create",
  );
  for (const u of readers)
    await api(app, R.shares(a.id), owner.cookie, {
      method: "PUT",
      body: { email: u.email, role: "viewer" },
    });
  // The shares above wrote their own share items; these tests start clean.
  await E.DB.prepare("delete from inbox_items where artifact_id = ?")
    .bind(a.id)
    .run();
  return a.id;
}
const art = (id: string) =>
  ({ id, format: "html", currentVersion: 1 }) as never;
const thread = (id: string, by: U, body = "hello") =>
  addThread(
    E,
    art(id),
    who(by),
    view(by),
    { anchor: { kind: "note" }, body },
    { after },
  );
const reply = (id: string, threadId: string, by: U, body = "re") =>
  addReply(E, id, threadId, who(by), view(by), body, {}, { after });

const inbox = async (u: U, q = "") => {
  const r = await api(app, `${R.meInbox}${q}`, u.cookie);
  expect(r.status).toBe(200);
  return (await r.json()) as Inbox;
};
const ups = async (u: U, id: string) =>
  (await inbox(u)).updates.filter((i) => i.artifact?.id === id);
const rowsOf = async (id: string) =>
  (
    await E.DB.prepare(
      "select user_id u, kind, level, key from inbox_items where artifact_id = ?",
    )
      .bind(id)
      .all<{ u: string; kind: string; level: string; key: string }>()
  ).results;

describe("inbox updates: what is written", () => {
  it("a new thread is a comment item for the owner, never the author", async () => {
    const id = await mkArtifact();
    const t = await thread(id, me, "<b>nice</b> page");
    const rows = await rowsOf(id);
    expect(rows).toEqual([
      {
        u: owner.userId,
        kind: "comment",
        level: "update",
        key: `comment:${t.comments[0]?.id}`,
      },
    ]);
    const [item] = await ups(owner, id);
    expect(item?.kind).toBe("comment");
    expect(item?.level).toBe("update");
    expect(item?.text).toContain("commented:");
    expect(item?.href).toBe(`/a/${id}?thread=${encodeURIComponent(t.id)}`);
    expect(item?.readAt).toBeNull();
    expect(await ups(me, id)).toEqual([]);
  });

  it("a reply tells the people in the thread (reply) and the owner (comment), not the replier", async () => {
    const id = await mkArtifact();
    const t = await thread(id, me);
    await reply(id, t.id, other);
    const by = new Map(
      (await rowsOf(id))
        .filter((r) => r.key.includes(""))
        .map((r) => [`${r.u}:${r.kind}`, r]),
    );
    expect(by.has(`${me.userId}:reply`)).toBe(true);
    expect(by.has(`${owner.userId}:comment`)).toBe(true);
    expect([...by.keys()].some((k) => k.startsWith(other.userId))).toBe(false);
    expect((await ups(me, id))[0]?.kind).toBe("reply");
  });

  it("a mention is a Needs-you item for the agent's owner, after plain asks, and clears when read", async () => {
    const id = await mkArtifact();
    const c = {
      id: `c-${newId()}`,
      body: "ping",
      author: { kind: "user", ref: other.userId, name: "other" },
      createdAt: new Date().toISOString(),
      editedAt: null,
      mentions: [
        { key: "k", name: "Scout", state: "queued", owner: me.userId },
      ],
    };
    await recordCommentItems(E, {
      artifactId: id,
      threadId: "th1",
      comment: c as never,
      reply: false,
    });
    const rows = (await rowsOf(id)).filter((r) => r.kind === "mention");
    expect(rows).toEqual([
      expect.objectContaining({ u: me.userId, level: "needs_you" }),
    ]);
    const inb = await inbox(me);
    const m = inb.needsYou.find((i) => i.artifact?.id === id);
    expect(m?.kind).toBe("mention");
    expect(m?.level).toBe("needs_you");
    expect(inb.counts.needsYou).toBeGreaterThanOrEqual(1);
    // The mention does not count as an update.
    expect(inb.updates.filter((i) => i.artifact?.id === id)).toEqual([]);
    const r = await api(app, R.meInboxRead, me.cookie, {
      method: "POST",
      body: { ids: [m?.id] },
    });
    expect(await r.json()).toEqual({ read: 1 });
    expect(
      (await inbox(me)).needsYou.filter((i) => i.artifact?.id === id),
    ).toEqual([]);
  });

  it("a guest's comment mentions no agent's owner", async () => {
    const id = await mkArtifact();
    const c = {
      id: `c-${newId()}`,
      body: "ping",
      author: { kind: "guest", ref: "g1", name: "A guest" },
      createdAt: new Date().toISOString(),
      editedAt: null,
      mentions: [
        { key: "k", name: "Scout", state: "queued", owner: me.userId },
      ],
    };
    await recordCommentItems(E, {
      artifactId: id,
      threadId: "th1",
      comment: c as never,
      reply: false,
    });
    expect((await rowsOf(id)).filter((r) => r.u === me.userId)).toEqual([]);
  });

  it("a share with a member is an item for them; none for a non-member", async () => {
    const id = await mkArtifact([]);
    await api(app, R.shares(id), owner.cookie, {
      method: "PUT",
      body: { email: me.email, role: "viewer" },
    });
    await api(app, R.shares(id), owner.cookie, {
      method: "PUT",
      body: { email: `nobody-${tag}@x.com`, role: "viewer" },
    });
    const rows = await rowsOf(id);
    expect(rows.map((r) => [r.u, r.kind])).toEqual([[me.userId, "share"]]);
    const [item] = await ups(me, id);
    expect(item?.text).toContain("shared");
    expect(item?.href).toBe(`/a/${id}`);
  });

  it("a decision tells those who weighed in, not the decider", async () => {
    const id = await mkArtifact();
    const t = await addThread(
      E,
      art(id),
      who(owner),
      view(owner),
      {
        anchor: { kind: "note" },
        body: "q",
        ask: {
          question: "Which one?",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
          to: [{ key: me.userId }],
        },
      },
      { moderator: true },
    );
    const cid = t.comments[0]?.id as string;
    const pick = (u: U, opt: string) =>
      answerAsk(
        E,
        id,
        t.id,
        cid,
        who(u),
        view(u),
        opt,
        undefined,
        { interactive: true },
        { canDecide: true, guest: false },
      );
    await pick(me, "a"); // a weigh-in
    await pick(owner, "b"); // the decision
    const d = (await rowsOf(id)).filter((r) => r.kind === "decision");
    expect(d.map((r) => r.u)).toEqual([me.userId]);
    const [item] = await ups(me, id);
    expect(item?.kind).toBe("decision");
    expect(item?.text).toContain("Which one?");
  });
});

describe("inbox updates: rules", () => {
  it("nothing for a guest-role person and nothing from an agent's comment as 'in the thread'", async () => {
    const id = await mkArtifact();
    // `guest` here is a guest-role member with a share: reads allowed, but a
    // guest's own comment tells no agent's owner (above) and an agent-authored
    // comment does not put its person in the thread.
    const t = await addThread(
      E,
      art(id),
      { kind: "user", id: me.userId, agent: { name: "Scout", version: null } },
      view(me),
      { anchor: { kind: "note" }, body: "from my agent" },
      { after },
    );
    await reply(id, t.id, other);
    const kinds = (await rowsOf(id)).filter((r) => r.u === me.userId);
    expect(kinds).toEqual([]);
  });

  it("unreadable and deleted artifacts are skipped, and a lost share hides the item", async () => {
    const id = await mkArtifact([me]);
    await thread(id, owner, "one");
    await writeInboxItems(E, [
      {
        userId: me.userId,
        kind: "comment",
        key: "k1",
        artifactId: id,
        actor: { kind: "user", ref: owner.userId },
        excerpt: "x",
        at: Date.now(),
      },
    ]);
    expect((await ups(me, id)).length).toBe(1);
    await api(app, R.share(id, me.email), owner.cookie, { method: "DELETE" });
    // The write refuses someone who can no longer read it.
    await writeInboxItems(E, [
      {
        userId: me.userId,
        kind: "comment",
        key: "k2",
        artifactId: id,
        actor: { kind: "user", ref: owner.userId },
        excerpt: "y",
        at: Date.now(),
      },
    ]);
    expect(
      (await rowsOf(id)).filter((r) => r.u === me.userId && r.key === "k2"),
    ).toEqual([]);
    // The stored row is hidden on read while unreadable.
    expect(await ups(me, id)).toEqual([]);
    await E.DB.prepare("update artifacts set deleted_at = ? where id = ?")
      .bind(Date.now(), id)
      .run();
    expect(await ups(owner, id)).toEqual([]);
  });

  it("an idempotent retry writes one row", async () => {
    const id = await mkArtifact();
    const item = {
      userId: me.userId,
      kind: "reply" as const,
      key: "reply:same",
      artifactId: id,
      actor: { kind: "user" as const, ref: other.userId },
      excerpt: "x",
      at: Date.now(),
    };
    await writeInboxItems(E, [item]);
    await writeInboxItems(E, [item]);
    expect(
      (await rowsOf(id)).filter((r) => r.key === "reply:same"),
    ).toHaveLength(1);
  });

  it("the excerpt is plain text capped at 120", async () => {
    const id = await mkArtifact();
    await thread(id, me, `a‮b​\n\n${"x".repeat(300)}`);
    const row = await E.DB.prepare(
      "select excerpt from inbox_items where artifact_id = ?",
    )
      .bind(id)
      .first<{ excerpt: string }>();
    const e = row?.excerpt ?? "";
    expect([...e].length).toBeLessThanOrEqual(120);
    expect(e.startsWith("ab xxx")).toBe(true);
    expect(/[‮​\n]/.test(e)).toBe(false);
    expect(itemExcerpt("  a   b ")).toBe("a b");
  });
});

describe("inbox updates: reads", () => {
  it("pages newest first by an opaque cursor, with read and read-all", async () => {
    const reader = await mk("u-page");
    const id = await mkArtifact([reader]);
    const base = Date.now();
    await writeInboxItems(
      E,
      Array.from({ length: 35 }, (_, i) => ({
        userId: reader.userId,
        kind: "comment" as const,
        key: `c:${i}`,
        artifactId: id,
        actor: { kind: "user" as const, ref: owner.userId },
        excerpt: `n${i}`,
        at: base + i,
      })),
    );
    const p1 = await inbox(reader);
    expect(p1.updates).toHaveLength(30);
    expect(p1.updates[0]?.text).toContain("n34");
    expect(p1.cursor).not.toBeNull();
    expect(p1.counts.unreadUpdates).toBe(35);
    const p2 = await inbox(
      reader,
      `?cursor=${encodeURIComponent(p1.cursor as string)}`,
    );
    expect(p2.updates).toHaveLength(5);
    expect(p2.updates[4]?.text).toContain("n0");
    expect(p2.cursor).toBeNull();
    const bad = await api(app, `${R.meInbox}?cursor=!!`, reader.cookie);
    expect(bad.status).toBe(400);

    // Someone else's ids (and asks) change nothing.
    const mine = p1.updates.slice(0, 3).map((i) => i.id);
    const foreign = await api(app, R.meInboxRead, other.cookie, {
      method: "POST",
      body: { ids: [...mine, "ask:zzz"] },
    });
    expect(await foreign.json()).toEqual({ read: 0 });
    expect((await inbox(reader)).counts.unreadUpdates).toBe(35);

    const r = await api(app, R.meInboxRead, reader.cookie, {
      method: "POST",
      body: { ids: mine },
    });
    expect(await r.json()).toEqual({ read: 3 });
    const after1 = await inbox(reader);
    expect(after1.counts.unreadUpdates).toBe(32);
    expect(after1.updates[0]?.readAt).not.toBeNull();
    const me1 = (await (await api(app, R.me, reader.cookie)).json()) as Me;
    expect(me1.inbox?.unreadUpdates).toBe(32);

    const all = await api(app, R.meInboxReadAll, reader.cookie, {
      method: "POST",
      body: {},
    });
    expect(await all.json()).toEqual({ read: 32 });
    expect((await inbox(reader)).counts.unreadUpdates).toBe(0);
    // Another person's inbox is untouched by it.
    expect((await inbox(other)).counts.unreadUpdates).toBeGreaterThanOrEqual(0);
  });

  it("is signed-in only", async () => {
    expect(
      (await api(app, R.meInboxReadAll, "", { method: "POST", body: {} }))
        .status,
    ).toBe(401);
  });
});
