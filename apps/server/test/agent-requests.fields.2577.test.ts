import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type BusNotice,
  HELD_LAPSE_MS,
  LISTEN_PAGE_MS,
  type Member,
  newId,
  type CommentThread as Thread,
} from "@oa/shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { Env } from "../src/env.js";
import {
  type ArtifactRuntime,
  runtimeCall,
  runtimeStub,
} from "../src/runtime/do.js";
import {
  allow,
  listHeld,
  notNow,
  removeListen,
} from "../src/services/agent-requests.js";
import { publish } from "../src/services/artifacts.js";
import {
  type DeliveryOutcome,
  installDelivery,
  type NoticeDelivery,
} from "../src/services/bus-delivery.js";
import {
  addReply,
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
import { connectedMachine, FakeHubs } from "./comment-hub.js";
import { login } from "./helpers.js";

// #2577: the server-data gaps: held editedAt and the allow's Undo entry id
// (both opt-in), the asker's request facts, and an agent reply's askedBy.

// The owner's agent is a real hub identity (the stub hubs), as in the ask tests.
const ID = (name: string, ns: string) => `id-${ns}-${name}`;
const hubs = new FakeHubs();
let E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();

class FakeBus implements NoticeDelivery {
  outcome: DeliveryOutcome = "delivered";
  async deliver(_e: Env, _userId: string, n: BusNotice) {
    return n.kind === "commented" ? ("delivered" as const) : this.outcome;
  }
}
const bus = new FakeBus();
let prev: NoticeDelivery;
beforeAll(() => {
  prev = installDelivery(bus);
});
afterAll(() => installDelivery(prev));
beforeEach(async () => {
  bus.outcome = "delivered";
  await E.DB.prepare(
    "delete from counters where key like 'notice:mention:%'",
  ).run();
});
// An "all" or "space" entry would make later tests deliver instead of hold.
afterEach(async () => {
  await E.DB.prepare("delete from agent_listens where owner_id = ?")
    .bind(owner.userId)
    .run();
});

type U = { userId: string; member: Member; email: string };
async function mk(prefix: string, name: string): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, "member");
  await E.DB.prepare("update users set name = ?1 where id = ?2")
    .bind(name, l.userId)
    .run();
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { userId: l.userId, member: m, email };
}
let owner: U;
let editor: U;
let other: U;
beforeAll(async () => {
  owner = await mk("fl-owner", "Olive Owner");
  editor = await mk("fl-editor", "Ada Asker");
  other = await mk("fl-other", "Bo Asker");
  E = hubs.env();
  await connectedMachine(E.DB, owner.userId);
  hubs.set({
    owner: owner.userId,
    identityId: ID("Claude", "ns-o"),
    ...CLAUDE,
  });
});

const typed = (u: U): CommentWho => ({
  kind: "user",
  id: u.userId,
  typed: true,
});
/** `interactive`: the route's interactiveSession(c); only a browser session has it. */
const view = (u: U, interactive = true): CommentViewer => ({
  userId: u.userId,
  short: null,
  moderator: true,
  ...(interactive ? { interactive: true } : {}),
});
const CLAUDE = { namespace: "ns-o", name: "Claude" };
/** The owner's verified agent: a bus identity the hub proved. */
const agentWho = (u: U, name = "Claude", ns = "ns-o"): CommentWho => ({
  kind: "user",
  id: u.userId,
  agent: {
    name,
    version: null,
    via: { kind: "token", id: "t1" },
    identity: {
      identityId: ID(name, ns),
      namespace: ns,
      name,
      kind: "claude-code",
    },
  },
});
const agentView = (u: U): CommentViewer => ({
  userId: u.userId,
  short: null,
  moderator: true,
  agent: { name: "Claude", version: null, via: { kind: "token", id: "t1" } },
});
const art = (id: string) =>
  ({ id, format: "html", currentVersion: 1 }) as never;

async function setup(shareWith: U[] = [editor]) {
  const a = await publish(
    E,
    owner.member,
    { title: "doc", format: "html", content: "<p>x</p>" } as never,
    null,
    undefined,
    "create",
  );
  for (const u of shareWith)
    await putShare(E, owner.member, a.id, { email: u.email, role: "editor" });
  await follow(E, owner.userId, CLAUDE, a.id);
  const list = await artifactAgents(E, a.id, editor.userId);
  const claude = list.find((x) => x.name.startsWith("Claude"))?.key as string;
  return { id: a.id, claude };
}
const post = (id: string, u: U, body: string, key: string) =>
  addThread(
    E,
    art(id),
    typed(u),
    view(u),
    { anchor: { kind: "note" }, body, mentions: [{ key }] },
    { moderator: true },
  ) as Promise<Thread>;
const reply = (
  id: string,
  threadId: string,
  who: CommentWho,
  v: CommentViewer,
  body: string,
  extras: Record<string, unknown> = {},
) =>
  addReply(E, id, threadId, who, v, body, extras as never, { moderator: true });
const held = async (id: string, details = false) =>
  (await listHeld(E, owner.userId, Date.now(), details)).requests.filter(
    (r) => r.artifact.id === id,
  );
const threadsAs = async (id: string, v: CommentViewer) =>
  (await listComments(E, id, "all", v)).threads;
const firstAs = async (id: string, v: CommentViewer) =>
  (await threadsAs(id, v))[0]?.comments[0];
/** The daemon's ack of a mention. */
const settle = (s: { id: string; claude: string }, commentId: string) =>
  runtimeCall(() =>
    runtimeStub(E, s.id).commentsTargetSettle({
      commentId,
      kind: "mention",
      key: s.claude,
      state: "delivered",
    }),
  );
const itemsOf = (r: Awaited<ReturnType<typeof held>>[number] | undefined) =>
  (r?.items ?? []).map((i) => ({
    commentId: i.commentId,
    wordsHash: i.wordsHash,
  }));
/** Allows only these comments (others stay held). */
const allowOnly = async (id: string, commentIds: string[]) => {
  const r = (await held(id)).find((x) =>
    x.items.some((i) => commentIds.includes(i.commentId)),
  );
  return allow(E, owner.userId, r?.id as string, {
    level: "once",
    items: itemsOf(r).filter((i) => commentIds.includes(i.commentId)),
  });
};

describe("held editedAt (opt-in)", () => {
  it("is never on the old shape; with details it is the comment's own editedAt", async () => {
    const s = await setup();
    const t = await post(s.id, editor, "first words", s.claude);
    const c0 = t.comments[0];
    await editComment(
      E,
      s.id,
      t.id,
      c0?.id as string,
      typed(editor),
      view(editor),
      "second words",
    );
    const [plain] = await held(s.id);
    expect(plain?.items[0]).not.toHaveProperty("editedAt");
    const [r] = await held(s.id, true);
    const stored = await firstAs(s.id, view(editor));
    expect(stored?.editedAt).toEqual(expect.any(String));
    expect(r?.items[0]?.editedAt).toBe(stored?.editedAt);
    // Never edited: absent even with details.
    const s2 = await setup();
    await post(s2.id, editor, "untouched", s2.claude);
    expect((await held(s2.id, true))[0]?.items[0]).not.toHaveProperty(
      "editedAt",
    );
    // The hash the notice carried still decides the allow.
    expect(
      await allow(E, owner.userId, r?.id as string, {
        level: "once",
        items: itemsOf(r),
      }),
    ).toEqual({ sent: 1, changed: 0, waiting: 0 });
  });
});

describe("allow entry id (Undo, opt-in)", () => {
  const live = (id: string) =>
    E.DB.prepare(
      "select id from agent_listens where owner_id = ?1 and member_id = ?2 and removed_at is null and until > ?3 and (artifact_id = ?4 or scope != 'page')",
    )
      .bind(owner.userId, editor.userId, Date.now(), id)
      .all<{ id: string }>();
  const space = async () => {
    const id = `sp_${newId().slice(0, 10)}`;
    await E.DB.prepare(
      "insert into spaces (id, kind, name, created_at) values (?, 'shared', ?, ?)",
    )
      .bind(id, "Launch", Date.now())
      .run();
    for (const u of [owner, editor])
      await E.DB.prepare(
        "insert or ignore into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'editor', 'manual', ?)",
      )
        .bind(id, u.userId, Date.now())
        .run();
    return id;
  };
  const YEAR = 365 * 86_400_000;

  it("old shape without details; once has no id even with it", async () => {
    const s = await setup();
    await post(s.id, editor, "one", s.claude);
    const [r] = await held(s.id);
    const out = await allow(E, owner.userId, r?.id as string, {
      level: "page",
      items: itemsOf(r),
    });
    expect(out).toEqual({ sent: 1, changed: 0, waiting: 0 });
    const s2 = await setup();
    await post(s2.id, editor, "two", s2.claude);
    const [r2] = await held(s2.id);
    expect(
      await allow(
        E,
        owner.userId,
        r2?.id as string,
        { level: "once", items: itemsOf(r2) },
        Date.now(),
        true,
      ),
    ).toEqual({ sent: 1, changed: 0, waiting: 0 });
  });

  it.each(["page", "space", "all"] as const)(
    "scope %s: a new entry returns its id and Undo removes only it",
    async (level) => {
      const s = await setup();
      if (level === "space")
        await E.DB.prepare("update artifacts set space_id = ? where id = ?")
          .bind(await space(), s.id)
          .run();
      await post(s.id, editor, "one", s.claude);
      const [r] = await held(s.id);
      const out = await allow(
        E,
        owner.userId,
        r?.id as string,
        { level, items: itemsOf(r), until: Date.now() + 30 * 86_400_000 },
        Date.now(),
        true,
      );
      expect(out.entryId).toEqual(expect.any(String));
      expect((await live(s.id)).results.map((x) => x.id)).toEqual([
        out.entryId,
      ]);
      await removeListen(E, owner.userId, out.entryId as string);
      expect((await live(s.id)).results).toHaveLength(0);
    },
  );

  it("an existing live entry is extended: no id, so Undo never removes an earlier grant", async () => {
    const s = await setup();
    await post(s.id, editor, "one", s.claude);
    const [r] = await held(s.id);
    const body = { level: "page" as const, items: itemsOf(r) };
    const first = await allow(
      E,
      owner.userId,
      r?.id as string,
      body,
      Date.now(),
      true,
    );
    const retry = await allow(
      E,
      owner.userId,
      r?.id as string,
      body,
      Date.now(),
      true,
    );
    expect(first.entryId).toEqual(expect.any(String));
    expect(retry.entryId).toBeUndefined();
    expect((await live(s.id)).results.map((x) => x.id)).toEqual([
      first.entryId,
    ]);
  });

  it("an ended row is no entry: a new one is made, with its own id", async () => {
    const s = await setup();
    await post(s.id, editor, "one", s.claude);
    const [r] = await held(s.id);
    const stale = newId();
    await E.DB.prepare(
      `insert into agent_listens (id, owner_id, member_id, scope, artifact_id, until, created_via, created_at)
       values (?, ?, ?, 'page', ?, ?, 'allow_page', ?)`,
    )
      .bind(
        stale,
        owner.userId,
        editor.userId,
        s.id,
        Date.now() - 1000,
        Date.now() - YEAR / 12,
      )
      .run();
    const out = await allow(
      E,
      owner.userId,
      r?.id as string,
      { level: "page", items: itemsOf(r) },
      Date.now(),
      true,
    );
    expect(out.entryId).toEqual(expect.any(String));
    expect(out.entryId).not.toBe(stale);
    expect((await live(s.id)).results.map((x) => x.id)).toEqual([out.entryId]);
  });

  it("two grants at once make one entry, hand out one id and keep the longest end", async () => {
    const s = await setup();
    await post(s.id, editor, "one", s.claude);
    const [r] = await held(s.id);
    const now = Date.now();
    const short = now + 10 * 86_400_000;
    const long = now + 30 * 86_400_000;
    const grant = (until: number) =>
      allow(
        E,
        owner.userId,
        r?.id as string,
        { level: "all" as const, items: itemsOf(r), until },
        now,
        true,
      );
    // The shorter request goes first so a check-then-insert would keep it.
    const [a, b] = await Promise.all([grant(short), grant(long)]);
    const ids = [a.entryId, b.entryId].filter(Boolean);
    expect(ids).toHaveLength(1);
    const rows = (
      await E.DB.prepare(
        "select id, until from agent_listens where owner_id = ? and member_id = ? and removed_at is null",
      )
        .bind(owner.userId, editor.userId)
        .all<{ id: string; until: number }>()
    ).results;
    expect(rows.map((x) => x.id)).toEqual(ids);
    expect(rows[0]?.until).toBe(long);
  });
});

describe("requestFacts", () => {
  it("waiting_owner and the lapse time, for the asker's own interactive session only", async () => {
    const s = await setup();
    await post(s.id, editor, "words", s.claude);
    const mine = await firstAs(s.id, view(editor));
    expect(mine?.mentions?.[0]?.delivery).toBe("queued");
    expect(mine?.requestFacts).toHaveLength(1);
    const f = mine?.requestFacts?.[0];
    expect(f).toMatchObject({ key: s.claude, status: "waiting_owner" });
    expect(
      Math.abs(
        Date.parse(f?.lapsesAt as string) - (Date.now() + HELD_LAPSE_MS),
      ),
    ).toBeLessThan(60_000);
    const none = async (v: CommentViewer) =>
      expect((await firstAs(s.id, v))?.requestFacts).toBeUndefined();
    // A PAT caller: same user, no agent label, but not a browser session.
    await none(view(editor, false));
    await none({ ...view(editor), agent: agentView(editor).agent });
    await none({ ...view(editor), guest: true });
    await none({ userId: null, short: "g1", guest: true });
    await none(view(owner));
    await none(agentView(owner));
  });

  it("a Not now reads the same, a lapse reads lapsed, an allow clears it", async () => {
    const s = await setup();
    await post(s.id, editor, "words", s.claude);
    const [r] = await held(s.id);
    await notNow(E, owner.userId, r?.id as string);
    const quiet = (await firstAs(s.id, view(editor)))?.requestFacts;
    expect(quiet).toMatchObject([{ status: "waiting_owner" }]);
    expect(JSON.stringify(quiet)).not.toContain("quiet");
    const expire = (at: number) =>
      E.DB.prepare(
        "update held_request_items set expires_at = ?1 where request_id = ?2",
      )
        .bind(at, r?.id)
        .run();
    await expire(Date.now() - 1000);
    expect((await firstAs(s.id, view(editor)))?.requestFacts).toMatchObject([
      { status: "lapsed" },
    ]);
    await expire(Date.now() + 1000);
    await allowOnly(s.id, [r?.items[0]?.commentId as string]);
    expect((await firstAs(s.id, view(editor)))?.requestFacts).toBeUndefined();
  });

  it("a lapsed hold whose D1 row was swept stays lapsed; an unreadable D1 claims no status", async () => {
    const s = await setup();
    const t = await post(s.id, editor, "words", s.claude);
    const cid = t.comments[0]?.id as string;
    // Eight days old, and the nightly sweep has since deleted its D1 detail.
    await runInDurableObject(
      runtimeStub(E, s.id) as unknown as DurableObjectStub<ArtifactRuntime>,
      (i) =>
        (
          i as unknown as {
            ctx: {
              storage: { sql: { exec: (q: string, ...a: unknown[]) => void } };
            };
          }
        ).ctx.storage.sql.exec(
          "update comments set created_at = ? where id = ?",
          new Date(Date.now() - 8 * 86_400_000).toISOString(),
          cid,
        ),
    );
    await E.DB.prepare("delete from held_request_items where comment_id = ?")
      .bind(cid)
      .run();
    expect((await firstAs(s.id, view(editor)))?.requestFacts).toMatchObject([
      { key: s.claude, status: "lapsed" },
    ]);
    const down = {
      ...E,
      DB: new Proxy(E.DB, {
        get: (t2, k) =>
          k === "prepare"
            ? (sql: string) => {
                if (sql.includes("held_request_items"))
                  throw new Error("D1 down");
                return t2.prepare(sql);
              }
            : (t2 as never)[k],
      }),
    } as unknown as Env;
    const out = (await listComments(down, s.id, "all", view(editor)))
      .threads[0];
    expect(out?.comments[0]?.requestFacts).toBeUndefined();
  });

  it("offline only where the hub recorded the agent away and accepted the notice; never a held, dropped or unacked one", async () => {
    const s = await setup();
    const flag = (threadId: string, commentId: string, away: boolean) =>
      runtimeCall(() =>
        runtimeStub(E, s.id).commentsTargetStates({
          threadId,
          commentId,
          states: [
            {
              kind: "mention",
              key: s.claude,
              state: "queued",
              ...(away ? { away: true } : {}),
            },
          ],
        }),
      );
    // The owner's own mention of their own agent: not held. The bus queued it (unacked).
    bus.outcome = "held";
    const t = await post(s.id, owner, "wake up", s.claude);
    const c = t.comments[0]?.id as string;
    const facts = async () => (await firstAs(s.id, view(owner)))?.requestFacts;
    expect((await firstAs(s.id, view(owner)))?.mentions?.[0]?.delivery).toBe(
      "queued",
    );
    expect(await facts()).toBeUndefined();
    await flag(t.id, c, true);
    expect(await facts()).toEqual([{ key: s.claude, status: "offline" }]);
    // The daemon's ack settles it: no longer offline.
    await settle(s, c);
    expect(await facts()).toBeUndefined();
    // Dropped (no session, a stalled hub, a deleted address): gone, not offline.
    bus.outcome = "dropped";
    const t2 = await post(s.id, owner, "again", s.claude);
    const g = (await threadsAs(s.id, view(owner))).find((x) => x.id === t2.id);
    expect(g?.comments[0]?.mentions?.[0]?.delivery).toBe("gone");
    expect(g?.comments[0]?.requestFacts).toBeUndefined();
    // Held for another person's agent: waiting for them, never offline.
    const t3 = await post(s.id, editor, "held one", s.claude);
    const h = (await threadsAs(s.id, view(editor))).find((x) => x.id === t3.id);
    expect(h?.comments[0]?.requestFacts?.map((f) => f.status)).toEqual([
      "waiting_owner",
    ]);
  });
});

describe("askedBy on an agent's reply", () => {
  /** Two people ask the owner's agent in one thread; the owner allows `which`. */
  async function twoAskers(allowed: "a" | "b" | "none") {
    const s = await setup([editor, other]);
    const t = await post(s.id, editor, "A: what is the 42%?", s.claude);
    const a = t.comments[0]?.id as string;
    const b = (
      await reply(s.id, t.id, typed(other), view(other), "B: and the 17%?", {
        mentions: [{ key: s.claude }],
      })
    ).id;
    if (allowed !== "none") await allowOnly(s.id, [allowed === "a" ? a : b]);
    return { s, t, a, b };
  }
  const answer = (
    x: { s: { id: string }; t: { id: string } },
    requestCommentId?: string,
    who: CommentWho = agentWho(owner),
  ) =>
    reply(
      x.s.id,
      x.t.id,
      who,
      agentView(owner),
      "the answer",
      requestCommentId ? { requestCommentId } : {},
    );

  it("names the asker the reply points at, even when another asker's comment is adjacent", async () => {
    const x = await twoAskers("a");
    // B's comment is the one right before the reply, but B's was never released.
    expect((await answer(x, x.a)).askedBy).toEqual({ name: "Ada Asker" });
    expect((await answer(x, x.b)).askedBy).toBeUndefined();
    expect((await answer(x)).askedBy).toBeUndefined();
    // Stored, so it reads back on a list, for a member.
    const stored = (await threadsAs(x.s.id, view(editor)))[0]?.comments.filter(
      (c) => c.askedBy,
    );
    expect(stored?.map((c) => c.askedBy?.name)).toEqual(["Ada Asker"]);
  });

  it("the other asker is named once that one is released instead", async () => {
    const x = await twoAskers("b");
    expect((await answer(x, x.a)).askedBy).toBeUndefined();
    expect((await answer(x, x.b)).askedBy).toEqual({ name: "Bo Asker" });
  });

  it("nothing is released: no askedBy, and no error or text leaks", async () => {
    const x = await twoAskers("none");
    const out = await answer(x, x.a);
    expect(out.askedBy).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("42%");
  });

  it("an edit after the release sends it back to held: no askedBy until allowed again", async () => {
    const x = await twoAskers("a");
    await editComment(
      E,
      x.s.id,
      x.t.id,
      x.a,
      typed(editor),
      view(editor),
      "A: new words",
    );
    expect((await answer(x, x.a)).askedBy).toBeUndefined();
  });

  it("is left out for an unlinked agent, another agent, another thread, a person's reply and an unknown id", async () => {
    const x = await twoAskers("a");
    const unlinked: CommentWho = {
      kind: "user",
      id: owner.userId,
      agent: {
        name: "Claude",
        version: null,
        via: { kind: "token", id: "t1" },
      },
    };
    expect((await answer(x, x.a, unlinked)).askedBy).toBeUndefined();
    expect(
      (await answer(x, x.a, agentWho(owner, "Codex", "ns-o"))).askedBy,
    ).toBeUndefined();
    // Not the agent's owner: someone else's linked agent never matches.
    expect((await answer(x, x.a, agentWho(editor))).askedBy).toBeUndefined();
    const t2 = await post(x.s.id, owner, "elsewhere", x.s.claude);
    expect((await answer({ s: x.s, t: t2 }, x.a)).askedBy).toBeUndefined();
    expect((await answer(x, "no-such-comment")).askedBy).toBeUndefined();
    // A person's own reply never carries it, even typed with the field.
    const own = await reply(x.s.id, x.t.id, typed(owner), view(owner), "hi", {
      requestCommentId: x.a,
    });
    expect(own.askedBy).toBeUndefined();
  });

  it("a notice the bus did not acknowledge is no evidence; an acknowledged one is", async () => {
    const s = await setup();
    bus.outcome = "held";
    const t = await post(s.id, owner, "wake", s.claude);
    const c = t.comments[0]?.id as string;
    const x = { s, t };
    expect((await answer(x, c)).askedBy).toBeUndefined();
    await settle(s, c);
    expect((await answer(x, c)).askedBy).toEqual({ name: "Olive Owner" });
  });

  /**
   * A different member's followed agent that the hub lists as `state`, and a
   * sender (the editor) on that member's list. The POST roster reads no hub for
   * a follower, so the state is only known from the targeted read in deliver.
   */
  const AWAY = { namespace: "ns-a", name: "Away" };
  let awayOwner: U | undefined;
  async function awayAgent(state: "away" | "live") {
    awayOwner ??= await mk("fl-away", "Ann Agent");
    const ao = awayOwner;
    await E.DB.prepare("delete from bus_machines where user_id = ?")
      .bind(ao.userId)
      .run();
    await connectedMachine(E.DB, ao.userId);
    hubs.set({
      owner: ao.userId,
      identityId: ID("Away", "ns-a"),
      ...AWAY,
      state,
    });
    const a = await publish(
      E,
      owner.member,
      { title: "doc", format: "html", content: "<p>x</p>" } as never,
      null,
      undefined,
      "create",
    );
    for (const u of [editor, ao])
      await putShare(E, owner.member, a.id, { email: u.email, role: "editor" });
    await follow(E, ao.userId, AWAY, a.id);
    await E.DB.prepare(
      `insert into agent_listens (id, owner_id, member_id, scope, artifact_id, until, created_via, created_at)
       values (?, ?, ?, 'page', ?, ?, 'allow_page', ?)`,
    )
      .bind(
        newId(),
        ao.userId,
        editor.userId,
        a.id,
        Date.now() + LISTEN_PAGE_MS,
        Date.now(),
      )
      .run();
    const key = (await artifactAgents(E, a.id, editor.userId)).find((x) =>
      x.name.startsWith("Away"),
    )?.key as string;
    // The agent's own reply, as its verified identity.
    const answerAs = (threadId: string, requestCommentId: string) =>
      reply(
        a.id,
        threadId,
        agentWho(ao, "Away", "ns-a"),
        {
          userId: ao.userId,
          short: null,
          moderator: true,
          agent: {
            name: "Away",
            version: null,
            via: { kind: "token", id: "t1" },
          },
        },
        "the answer",
        { requestCommentId },
      );
    return { s: { id: a.id, claude: key }, ao, answerAs };
  }
  const askTo = (id: string, u: U, key: string) =>
    addThread(
      E,
      art(id),
      typed(u),
      view(u),
      {
        anchor: { kind: "note" },
        body: "ask words",
        ask: {
          question: "ok?",
          options: [
            { id: "a", label: "yes" },
            { id: "b", label: "no" },
          ],
          to: [{ key }],
        },
      },
      { moderator: true },
    ) as Promise<Thread>;
  const offline = async (id: string, u: U) => {
    const x = (await firstAs(id, view(u)))?.requestFacts;
    return x?.map((f) => f.status);
  };

  it("a listed sender's mention of another member's away agent reads offline, and once acknowledged it names the asker", async () => {
    const { s, answerAs } = await awayAgent("away");
    bus.outcome = "held";
    const t = await post(s.id, editor, "wake", s.claude);
    const c = t.comments[0]?.id as string;
    expect(await offline(s.id, editor)).toEqual(["offline"]);
    await settle(s, c);
    expect(await offline(s.id, editor)).toBeUndefined();
    expect((await answerAs(t.id, c)).askedBy).toEqual({ name: "Ada Asker" });
  });

  it("an agent the hub lists as live, or a bare queue, is never offline", async () => {
    const { s } = await awayAgent("live");
    bus.outcome = "held";
    const t = await post(s.id, editor, "wake", s.claude);
    expect((await firstAs(s.id, view(editor)))?.mentions?.[0]?.delivery).toBe(
      "queued",
    );
    expect(await offline(s.id, editor)).toBeUndefined();
    expect(t.comments[0]?.requestFacts).toBeUndefined();
  });

  it("a direct ask to another member's away agent: offline, no @mention, and the ack names the asker", async () => {
    const { s, answerAs } = await awayAgent("away");
    bus.outcome = "held";
    const t = await askTo(s.id, editor, s.claude);
    const root = t.comments[0]?.id as string;
    // The ask is no public @mention: older clients see the same arrays as before.
    expect((await firstAs(s.id, view(editor)))?.mentions).toBeUndefined();
    expect(await offline(s.id, editor)).toEqual(["offline"]);
    expect((await answerAs(t.id, root)).askedBy).toBeUndefined();
    // notifyAgent's ack of an ask carries kind "mention".
    await settle(s, root);
    expect(await offline(s.id, editor)).toBeUndefined();
    expect((await firstAs(s.id, view(editor)))?.mentions).toBeUndefined();
    expect((await answerAs(t.id, root)).askedBy).toEqual({ name: "Ada Asker" });
  });

  it("a direct ask to your own agent is acknowledged like a mention, with no public mention", async () => {
    const s = await setup();
    bus.outcome = "held";
    const t = await askTo(s.id, owner, s.claude);
    const root = t.comments[0]?.id as string;
    expect((await firstAs(s.id, view(owner)))?.mentions).toBeUndefined();
    expect((await answer({ s, t }, root)).askedBy).toBeUndefined();
    await settle(s, root);
    expect((await answer({ s, t }, root)).askedBy).toEqual({
      name: "Olive Owner",
    });
  });

  it("a direct ask held for another person's agent waits for them: no offline, no mention", async () => {
    const s = await setup();
    const t = await askTo(s.id, editor, s.claude);
    const first = (await firstAs(s.id, view(editor)))?.requestFacts;
    expect(first?.map((f) => f.status)).toEqual(["waiting_owner"]);
    expect((await firstAs(s.id, view(editor)))?.mentions).toBeUndefined();
    expect((await answer({ s, t }, t.comments[0]?.id)).askedBy).toBeUndefined();
  });

  it("a released ask and a released thread reply name their asker", async () => {
    const s = await setup();
    const t = (await addThread(
      E,
      art(s.id),
      typed(editor),
      view(editor),
      {
        anchor: { kind: "note" },
        body: "ask words",
        ask: {
          question: "ok?",
          options: [
            { id: "a", label: "yes" },
            { id: "b", label: "no" },
          ],
          to: [{ key: s.claude }],
        },
      },
      { moderator: true },
    )) as Thread;
    const x = { s, t };
    const root = t.comments[0]?.id as string;
    await allowOnly(s.id, [root]);
    // The agent's answer also brings it into the thread, so the next reply is held for it.
    expect((await answer(x, root)).askedBy).toEqual({ name: "Ada Asker" });
    const r = await reply(s.id, t.id, typed(editor), view(editor), "and then?");
    expect((await answer(x, r.id)).askedBy).toBeUndefined();
    await allowOnly(s.id, [r.id]);
    expect((await answer(x, r.id)).askedBy).toEqual({ name: "Ada Asker" });
  });

  it("outsiders do not see it", async () => {
    const x = await twoAskers("a");
    await answer(x, x.a);
    const guest = (
      await threadsAs(x.s.id, { ...view(editor), guest: true })
    )[0];
    expect(guest?.comments.some((c) => c.askedBy)).toBe(false);
  });
});
