import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ArtifactAgent } from "@oa/shared";
import {
  type ArtifactSummary,
  type CommentList,
  type Member,
  newId,
  type Page,
  R,
  type CommentThread as Thread,
} from "@oa/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { callerOf } from "../src/auth/authz.js";
import type { Env } from "../src/env.js";
import { type ArtifactRuntime, runtimeStub } from "../src/runtime/do.js";
import { listQuery, publish } from "../src/services/artifacts.js";
import { askRows, reconcileAsks } from "../src/services/asks.js";
import {
  addReply,
  addThread,
  answerAsk,
  type CommentWho,
  deleteComment,
  listComments,
  setStatus,
  takeBackAsk,
} from "../src/services/comments.js";
import { follow } from "../src/services/follows.js";
import { deleteShare } from "../src/services/shares.js";
import { getUser } from "../src/services/users.js";
import { api, login } from "./helpers.js";

// #1623: the asks index behind asksForYou and filter=needs_answer.

const app = createApp();
const E = env as unknown as Env;
const tag = newId().slice(0, 6).toLowerCase();

type U = { cookie: string; userId: string; member: Member; email: string };
async function mk(prefix: string): Promise<U> {
  const email = `${prefix}-${tag}@x.com`;
  const l = await login(email, "member");
  const m = await getUser(E, l.userId);
  if (!m) throw new Error("no user");
  return { ...l, member: m, email };
}

let owner: U;
let reader: U;
let other: U;
let stranger: U;
beforeAll(async () => {
  owner = await mk("k-owner");
  reader = await mk("k-reader");
  other = await mk("k-other");
  stranger = await mk("k-stranger");
});

const NOTE = { kind: "note" };
const OPTS = [
  { id: "a", label: "Option A" },
  { id: "b", label: "Option B" },
];
const who = (u: U): CommentWho => ({ kind: "user", id: u.userId });
const view = (u: U) => ({ userId: u.userId, short: null, moderator: true });

/** An artifact the reader and the other person can both read. */
async function mkArtifact() {
  const a = await publish(
    E,
    owner.member,
    { title: "doc", format: "html", content: "<p>x</p>" } as never,
    null,
    undefined,
    "create",
  );
  for (const u of [reader, other])
    await api(app, R.shares(a.id), owner.cookie, {
      method: "PUT",
      body: { email: u.email, role: "viewer" },
    });
  return a.id;
}

/** The asker's own ask, through the service (an ask is MCP-only on the wire). */
function ask(id: string, to: U[], e: Env = E) {
  return addThread(
    e,
    { id, format: "html", currentVersion: 1 } as never,
    who(owner),
    view(owner),
    {
      anchor: NOTE,
      body: "Which one?",
      ask: {
        question: "Which one do we ship?",
        options: OPTS,
        to: to.map((u) => ({ key: u.userId })),
      },
    },
    { moderator: true },
  );
}

async function listFor(u: U, qs = "") {
  const r = await api(app, `${R.artifacts}?${qs}`, u.cookie);
  expect(r.status).toBe(200);
  return (await r.json()) as Page<ArtifactSummary>;
}
const countFor = async (u: U, id: string) =>
  (await listFor(u, "limit=100")).items.find((a) => a.id === id)?.asksForYou;
const rows = async (id: string) =>
  (
    await E.DB.prepare(
      "select addressee, open, answered from artifact_asks where artifact_id = ?",
    )
      .bind(id)
      .all<{ addressee: string; open: number; answered: number }>()
  ).results;

describe("asksForYou", () => {
  it("counts the open ask for the person asked, and nobody else", async () => {
    const id = await mkArtifact();
    await ask(id, [reader]);
    expect(await countFor(reader, id)).toBe(1);
    // The other person can read the artifact but was not asked; neither was the asker.
    expect(await countFor(other, id)).toBeUndefined();
    // The asker's own user decides, so it waits on them too (#2381).
    expect(await countFor(owner, id)).toBe(1);
  });

  it("an ask to two people counts once for each", async () => {
    const id = await mkArtifact();
    await ask(id, [reader, other]);
    expect(await countFor(reader, id)).toBe(1);
    expect(await countFor(other, id)).toBe(1);
    await ask(id, [reader]);
    expect(await countFor(reader, id)).toBe(2);
    expect(await countFor(other, id)).toBe(1);
  });

  it("an ask to someone's agent counts for the member whose agent it is", async () => {
    const id = await mkArtifact();
    await follow(
      E,
      reader.userId,
      { namespace: "ns-reader", name: "Codex" },
      id,
    );
    const agents = (await (
      await api(app, R.artifactAgents(id), owner.cookie)
    ).json()) as ArtifactAgent[];
    const key = agents.find((a) => a.name.startsWith("Codex"))?.key as string;
    await addThread(
      E,
      { id, format: "html", currentVersion: 1 } as never,
      who(owner),
      view(owner),
      {
        anchor: NOTE,
        body: "q",
        ask: { question: "Which?", options: OPTS, to: [{ key }] },
      },
      { moderator: true },
    );
    expect(await countFor(reader, id)).toBe(1);
    expect(await countFor(other, id)).toBeUndefined();
  });

  it("an answer closes it", async () => {
    const id = await mkArtifact();
    const t = await ask(id, [reader]);
    await answerAsk(
      E,
      id,
      t.id,
      t.comments[0]?.id as string,
      who(reader),
      view(reader),
      "a",
      undefined,
      { interactive: true },
      { canDecide: true, guest: false },
    );
    expect(await countFor(reader, id)).toBeUndefined();
    // A weigh-in closes it for the one who made it; the decider (the asker) still waits.
    expect(
      (await rows(id)).sort((x, y) => x.addressee.localeCompare(y.addressee)),
    ).toEqual(
      [
        { addressee: reader.userId, open: 0, answered: 1 },
        { addressee: owner.userId, open: 1, answered: 0 },
      ].sort((x, y) => x.addressee.localeCompare(y.addressee)),
    );
    expect(await countFor(owner, id)).toBe(1);
  });

  it("resolving closes it, and reopening brings back only an unanswered ask", async () => {
    const id = await mkArtifact();
    const t = await ask(id, [reader]);
    const t2 = await ask(id, [reader]);
    await answerAsk(
      E,
      id,
      t2.id,
      t2.comments[0]?.id as string,
      who(reader),
      view(reader),
      "b",
      undefined,
      { interactive: true },
      { canDecide: true, guest: false },
    );
    await setStatus(E, id, t.id, who(owner), view(owner), "resolved");
    await setStatus(E, id, t2.id, who(owner), view(owner), "resolved");
    expect(await countFor(reader, id)).toBeUndefined();
    await setStatus(E, id, t.id, who(owner), view(owner), "open");
    await setStatus(E, id, t2.id, who(owner), view(owner), "open");
    // t is open and unanswered again; t2 stays answered.
    expect(await countFor(reader, id)).toBe(1);
  });

  it("deleting the root, or the reply that carries the ask, drops it", async () => {
    const id = await mkArtifact();
    const t = await ask(id, [reader]);
    await deleteComment(
      E,
      id,
      t.id,
      t.comments[0]?.id as string,
      who(owner),
      true,
    );
    expect(await countFor(reader, id)).toBeUndefined();
    expect(await rows(id)).toEqual([]);

    const plain = (await (
      await api(app, R.comments(id), owner.cookie, {
        method: "POST",
        body: { anchor: NOTE, body: "plain" },
      })
    ).json()) as Thread;
    const c = await addReply(
      E,
      id,
      plain.id,
      who(owner),
      view(owner),
      "again",
      {
        ask: {
          question: "Which?",
          options: OPTS,
          to: [{ key: reader.userId }],
        },
      },
      { moderator: true },
    );
    expect(await countFor(reader, id)).toBe(1);
    await deleteComment(E, id, plain.id, c.id, who(owner), true);
    expect(await countFor(reader, id)).toBeUndefined();
    expect(await rows(id)).toEqual([]);
  });

  it("losing access drops it, and a person with no access never matches the filter", async () => {
    const id = await mkArtifact();
    await ask(id, [reader]);
    expect(await countFor(reader, id)).toBe(1);
    await deleteShare(E, owner.member, id, reader.email);
    expect(
      (await listFor(reader, "limit=100")).items.map((a) => a.id),
    ).not.toContain(id);
    expect(
      (await listFor(reader, "filter=needs_answer&limit=100")).items.map(
        (a) => a.id,
      ),
    ).not.toContain(id);
    // An ask to someone with no access at all never leaks to a stranger either.
    expect(await countFor(stranger, id)).toBeUndefined();
  });

  it("a deleted artifact counts for nobody; restoring brings it back; a purge drops the rows", async () => {
    const id = await mkArtifact();
    await ask(id, [reader]);
    await api(app, R.artifact(id), owner.cookie, { method: "DELETE" });
    expect(await countFor(reader, id)).toBeUndefined();
    const trashed = await api(
      app,
      `${R.artifacts}?includeDeleted=true&limit=100`,
      owner.cookie,
    );
    const items = ((await trashed.json()) as Page<ArtifactSummary>).items;
    expect(items.find((a) => a.id === id)?.asksForYou).toBeUndefined();
    await api(app, R.restoreDeleted(id), owner.cookie, { method: "POST" });
    expect(await countFor(reader, id)).toBe(1);
    await E.DB.prepare("delete from artifacts where id = ?").bind(id).run();
    expect(await rows(id)).toEqual([]);
  });
});

describe("filter=needs_answer", () => {
  it("lists only the artifacts with an open ask for the caller, and pages with the list cursor", async () => {
    const withAsk: string[] = [];
    const without: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await mkArtifact();
      if (i % 2 === 0) {
        await ask(id, [reader]);
        withAsk.push(id);
      } else {
        await ask(id, [other]);
        without.push(id);
      }
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = `filter=needs_answer&limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const p = await listFor(reader, q);
      seen.push(...p.items.map((a) => a.id));
      for (const a of p.items) expect(a.asksForYou).toBeGreaterThan(0);
      cursor = p.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    for (const id of withAsk) expect(seen).toContain(id);
    for (const id of without) expect(seen).not.toContain(id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(pages).toBeGreaterThan(1);
  });

  it("the unfiltered list still shows everything, newest first, with the count on the ones asked", async () => {
    const a = await mkArtifact();
    const b = await mkArtifact();
    await ask(a, [reader]);
    const all = (await listFor(reader, "limit=100")).items;
    const ids = all.map((x) => x.id);
    expect(ids.indexOf(b)).toBeLessThan(ids.indexOf(a));
    expect(all.find((x) => x.id === a)?.asksForYou).toBe(1);
    expect(all.find((x) => x.id === b)?.asksForYou).toBeUndefined();
  });

  it("one query, planned on the open-asks index, not a scan of asks", async () => {
    const q = listQuery(E, callerOf(reader.member), {
      scope: "all",
      limit: 25,
      includeDeleted: false,
      filter: "needs_answer",
    }).toSQL();
    const plan = await E.DB.prepare(`EXPLAIN QUERY PLAN ${q.sql}`)
      .bind(...q.params)
      .all<{ detail: string }>();
    const text = plan.results.map((r) => r.detail).join("\n");
    console.log(text);
    expect(text).toMatch(/artifact_asks_open_idx/);
    expect(text).not.toMatch(/SCAN k|SCAN artifact_asks/);
  });
});

describe("a failing index write", () => {
  /** An env whose D1 refuses every statement on artifact_asks. */
  const broken = (): Env => {
    const db = new Proxy(E.DB, {
      get(t, k) {
        const v = Reflect.get(t, k) as unknown;
        if (k === "prepare")
          return (sql: string) => {
            if (sql.includes("artifact_asks")) throw new Error("D1 is down");
            return t.prepare(sql);
          };
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    return { ...E, DB: db } as Env;
  };

  it("never fails the ask, and the next comments read repairs the missing row", async () => {
    const id = await mkArtifact();
    const t = await ask(id, [reader], broken());
    expect(t.comments[0]?.ask).toBeTruthy();
    expect(await rows(id)).toEqual([]);
    expect(await countFor(reader, id)).toBeUndefined();
    await listComments(E, id, "all", view(owner));
    expect(await countFor(reader, id)).toBe(1);
  });

  it("never fails an answer or a resolve, and the next read closes the stale row", async () => {
    const id = await mkArtifact();
    const t = await ask(id, [reader]);
    const cid = t.comments[0]?.id as string;
    const c = await answerAsk(
      broken(),
      id,
      t.id,
      cid,
      who(reader),
      view(reader),
      "a",
      undefined,
      { interactive: true },
      { canDecide: true, guest: false },
    );
    expect(c.ask?.picks?.[0]?.optionId).toBe("a");
    // Stale: still open in the index until it is repaired.
    expect(await countFor(reader, id)).toBe(1);
    await listComments(E, id, "all", view(owner));
    expect(await countFor(reader, id)).toBeUndefined();

    const t2 = await ask(id, [reader]);
    const r = await setStatus(
      broken(),
      id,
      t2.id,
      who(owner),
      view(owner),
      "resolved",
    );
    expect(r.status).toBe("resolved");
    expect(await countFor(reader, id)).toBe(1);
    await listComments(E, id, "all", view(owner));
    expect(await countFor(reader, id)).toBeUndefined();
  });

  it("never fails a delete, and the next read drops the stale row", async () => {
    const id = await mkArtifact();
    const t = await ask(id, [reader]);
    await deleteComment(
      broken(),
      id,
      t.id,
      t.comments[0]?.id as string,
      who(owner),
      true,
    );
    expect(await countFor(reader, id)).toBe(1);
    await listComments(E, id, "all", view(owner));
    expect(await rows(id)).toEqual([]);
  });

  it("asks that predate the table appear the first time the comments are listed", async () => {
    const id = await mkArtifact();
    await ask(id, [reader]);
    await E.DB.prepare("delete from artifact_asks where artifact_id = ?")
      .bind(id)
      .run();
    expect(await countFor(reader, id)).toBeUndefined();
    const l = (await (
      await api(app, R.comments(id), owner.cookie)
    ).json()) as CommentList;
    expect(l.threads).toHaveLength(1);
    expect(await countFor(reader, id)).toBe(1);
  });
});

describe("review fixes", () => {
  it("comments off hides the badge and the match; on brings them back", async () => {
    const id = await mkArtifact();
    await ask(id, [reader]);
    const set = (comments: boolean) =>
      api(app, R.artifact(id), owner.cookie, {
        method: "PATCH",
        body: { comments },
      });
    expect((await set(false)).status).toBe(200);
    expect(await countFor(reader, id)).toBeUndefined();
    expect(
      (await listFor(reader, "filter=needs_answer&limit=100")).items.map(
        (a) => a.id,
      ),
    ).not.toContain(id);
    expect((await set(true)).status).toBe(200);
    expect(await countFor(reader, id)).toBe(1);
  });

  it("an owner who is the addressee sees nothing for a trashed artifact, badge or filter", async () => {
    const id = await mkArtifact();
    await ask(id, [owner]);
    expect(await countFor(owner, id)).toBe(1);
    await api(app, R.artifact(id), owner.cookie, { method: "DELETE" });
    const r = await api(
      app,
      `${R.artifacts}?includeDeleted=true&limit=100`,
      owner.cookie,
    );
    const inTrash = ((await r.json()) as Page<ArtifactSummary>).items.find(
      (a) => a.id === id,
    );
    expect(inTrash).toBeTruthy();
    expect(inTrash?.asksForYou).toBeUndefined();
    const f = await api(
      app,
      `${R.artifacts}?includeDeleted=true&filter=needs_answer&limit=100`,
      owner.cookie,
    );
    expect(
      ((await f.json()) as Page<ArtifactSummary>).items.map((a) => a.id),
    ).not.toContain(id);
  });

  /** An env whose D1 counts batch calls (the reconcile's only write). */
  const counting = () => {
    const n = { batches: 0 };
    const db = new Proxy(E.DB, {
      get(t, k) {
        const v = Reflect.get(t, k) as unknown;
        if (k === "batch")
          return (x: D1PreparedStatement[]) => {
            n.batches++;
            return t.batch(x);
          };
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    return { n, env: { ...E, DB: db } as Env };
  };

  it("a reconcile that matches writes nothing; one that differs writes once", async () => {
    const id = await mkArtifact();
    await ask(id, [reader]);
    const c = counting();
    await listComments(c.env, id, "all", view(owner));
    expect(c.n.batches).toBe(0);
    await E.DB.prepare("delete from artifact_asks where artifact_id = ?")
      .bind(id)
      .run();
    await listComments(c.env, id, "all", view(owner));
    expect(c.n.batches).toBe(1);
  });

  it("only a full read (status=all) reconciles", async () => {
    const id = await mkArtifact();
    await ask(id, [reader]);
    await E.DB.prepare("delete from artifact_asks where artifact_id = ?")
      .bind(id)
      .run();
    for (const status of ["open", "resolved"]) {
      const r = await api(
        app,
        `${R.comments(id)}?status=${status}`,
        owner.cookie,
      );
      expect(r.status).toBe(200);
      expect(await rows(id)).toEqual([]);
    }
    await api(app, `${R.comments(id)}?status=all`, owner.cookie);
    expect(await rows(id)).toHaveLength(2);
  });

  it("a truncated read never deletes rows it may lack; a complete one does", async () => {
    const id = await mkArtifact();
    await ask(id, [reader]);
    const have = (await askRows(E, id)) ?? [];
    expect(have).toHaveLength(2);
    await reconcileAsks(E, id, [], true, have);
    expect(await rows(id)).toHaveLength(2);
    await reconcileAsks(E, id, [], false, have);
    expect(await rows(id)).toEqual([]);
  });
});

describe("deciders in the index (#2381)", () => {
  it("a legacy answer by a non-decider reconciles: closed for that person, open for the decider", async () => {
    const id = await mkArtifact();
    const t = await ask(id, [reader, other]);
    const cid = t.comments[0]?.id as string;
    await runInDurableObject(
      runtimeStub(E, id) as unknown as DurableObjectStub<ArtifactRuntime>,
      (_i, state) => {
        state.storage.sql.exec(
          "update comment_asks set answer = ? where comment_id = ?",
          JSON.stringify({
            optionId: "a",
            by: { kind: "user", ref: reader.userId, typed: true },
            at: new Date().toISOString(),
          }),
          cid,
        );
      },
    );
    await E.DB.prepare("delete from artifact_asks where artifact_id = ?")
      .bind(id)
      .run();
    await api(app, `${R.comments(id)}?status=all`, owner.cookie);
    const by = Object.fromEntries(
      (await rows(id)).map((r) => [r.addressee, r]),
    );
    expect(by[reader.userId]).toMatchObject({ open: 0, answered: 1 });
    expect(by[other.userId]).toMatchObject({ open: 1, answered: 0 });
    expect(by[owner.userId]).toMatchObject({ open: 1, answered: 0 });
  });

  it("a default decider who was not asked gets an open row", async () => {
    const id = await mkArtifact();
    await ask(id, [reader]);
    expect(await countFor(owner, id)).toBe(1);
    expect((await rows(id)).map((r) => r.addressee).sort()).toEqual(
      [owner.userId, reader.userId].sort(),
    );
  });
});

describe("taking a decision back (#2527)", () => {
  const byWho = async (id: string) =>
    Object.fromEntries((await rows(id)).map((r) => [r.addressee, r]));
  async function decided(to: U[], decider: U) {
    const id = await mkArtifact();
    await api(app, R.shares(id), owner.cookie, {
      method: "PUT",
      body: { email: decider.email, role: "editor" },
    });
    const t = await addThread(
      E,
      { id, format: "html", currentVersion: 1 } as never,
      who(owner),
      view(owner),
      {
        anchor: NOTE,
        body: "Which one?",
        ask: {
          question: "Which one do we ship?",
          options: OPTS,
          to: to.map((u) => ({ key: u.userId })),
          decider: { key: decider.userId },
        },
      },
      { moderator: true },
    );
    return { id, tid: t.id, cid: t.comments[0]?.id as string };
  }
  const takeBack = (s: { id: string; tid: string; cid: string }, u: U) =>
    api(app, R.commentAskDecider(s.id, s.tid, s.cid), u.cookie, {
      method: "POST",
      body: { takeBack: true },
    });

  it("the asker gets an open row, even after weighing in", async () => {
    const s = await decided([reader], other);
    await api(app, R.commentAnswer(s.id, s.tid, s.cid), owner.cookie, {
      method: "POST",
      body: { optionId: "a" },
    });
    expect((await byWho(s.id))[owner.userId]).toMatchObject({ open: 0 });
    expect((await takeBack(s, owner)).status).toBe(200);
    expect((await byWho(s.id))[owner.userId]).toMatchObject({
      open: 1,
      answered: 0,
    });
    expect(await countFor(owner, s.id)).toBe(1);
  });

  it("an old decider who was not asked loses their row", async () => {
    const s = await decided([reader], other);
    // The decider is always added to `to` on creation; an ask from before that
    // may not name them, so drop them from the stored addressees.
    await runInDurableObject(
      runtimeStub(E, s.id) as unknown as DurableObjectStub<ArtifactRuntime>,
      (_i, state) => {
        const r = state.storage.sql
          .exec(
            "select addressees from comment_asks where comment_id = ?",
            s.cid,
          )
          .one() as { addressees: string };
        const kept = (JSON.parse(r.addressees) as { key: string }[]).filter(
          (p) => p.key !== other.userId,
        );
        state.storage.sql.exec(
          "update comment_asks set addressees = ? where comment_id = ?",
          JSON.stringify(kept),
          s.cid,
        );
      },
    );
    expect((await byWho(s.id))[other.userId]).toBeDefined();
    expect((await takeBack(s, owner)).status).toBe(200);
    const by = await byWho(s.id);
    expect(by[other.userId]).toBeUndefined();
    expect(by[reader.userId]).toMatchObject({ open: 1 });
  });

  it("an old decider who is in to keeps an open row", async () => {
    const s = await decided([reader, other], other);
    expect((await takeBack(s, owner)).status).toBe(200);
    expect((await byWho(s.id))[other.userId]).toMatchObject({
      open: 1,
      answered: 0,
    });
  });

  it("on a risky ask the old decider's row goes even when asked", async () => {
    const s = await decided([reader], other);
    await runInDurableObject(
      runtimeStub(E, s.id) as unknown as DurableObjectStub<ArtifactRuntime>,
      (_i, state) => {
        state.storage.sql.exec(
          "update comment_asks set confirm = 'passkey' where comment_id = ?",
          s.cid,
        );
      },
    );
    expect((await byWho(s.id))[other.userId]).toBeDefined();
    expect((await takeBack(s, owner)).status).toBe(200);
    const by = await byWho(s.id);
    expect(by[other.userId]).toBeUndefined();
    expect(by[owner.userId]).toMatchObject({ open: 1 });
  });

  it("a refused take back changes no rows", async () => {
    const s = await decided([reader], other);
    const before = JSON.stringify(await byWho(s.id));
    const agent: CommentWho = {
      kind: "user",
      id: owner.userId,
      agent: { name: "Claude" },
    } as never;
    await expect(
      takeBackAsk(E, s.id, s.tid, s.cid, agent, view(owner)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      takeBackAsk(E, s.id, s.tid, s.cid, who(owner), view(owner)),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect((await takeBack(s, other)).status).toBe(403);
    expect(JSON.stringify(await byWho(s.id))).toBe(before);
    // Decided already: the CAS refuses.
    await api(app, R.commentAnswer(s.id, s.tid, s.cid), other.cookie, {
      method: "POST",
      body: { optionId: "a" },
    });
    const decidedRows = JSON.stringify(await byWho(s.id));
    expect((await takeBack(s, owner)).status).toBe(409);
    expect(JSON.stringify(await byWho(s.id))).toBe(decidedRows);
  });
});
