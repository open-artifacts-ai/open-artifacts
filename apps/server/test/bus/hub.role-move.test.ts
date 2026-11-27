// #3132: when a role moves from one session to another (the dashboard's
// Change holder, or a confirmed proposal), what the old session did while it
// held the role follows the role: an answer to an ask it posted then
// (identity-addressed), a mention of it after the move (by name) and the
// pages it began to follow then reach the new holder. What it began before
// it held the role stays its own, a session that still holds a role keeps
// its mail, and a name alone moves nothing (#3208). Real hub, real daemon
// sockets, the real follows service on D1. Waits are signals (reply frames,
// a list round trip), never sleeps; times are the hub's test clock and
// explicit follow rows, never the wall clock's order.
import { runInDurableObject } from "cloudflare:test";
import type { ServerFrame } from "@oa/bus-protocol";
import { type BusNotice, type Member, NOTICE_SENDER, newId } from "@oa/shared";
import { afterEach, describe, expect, it } from "vitest";
import { BusHub } from "../../src/bus/hub.js";
import { publish } from "../../src/services/artifacts.js";
import { noticeText, notifyChanged } from "../../src/services/follows.js";
import { getUser } from "../../src/services/users.js";
import {
  daemon,
  e,
  framesSeen,
  hello,
  hubOf,
  machine,
  member,
  ns,
  up,
  waitFor,
} from "./helpers.js";

type Reply<T extends ServerFrame["type"]> = Extract<ServerFrame, { type: T }>;

let seq = 0;
const id = (t: string) => `${t}${++seq}`;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;

async function setup() {
  const m = await member();
  const mach = await machine("Laptop", m.userId);
  const d = await daemon(mach.token);
  d.send({ ...hello(id("h")), caps: ["follow", "rename"] } as never);
  await waitFor(d, "hello_ok");
  const namespace = ns("move");
  const hub = await hubOf(m.userId);
  const sql = <T>(q: string, ...b: unknown[]) =>
    runInDurableObject(hub, (_, s) =>
      s.storage.sql.exec(q, ...(b as SqlStorageValue[])).toArray(),
    ) as Promise<T[]>;
  /** An open session with its own identity (#1822 link). */
  const reg = async (name: string) => {
    const ref = id("ref");
    d.send(up(id("u"), ref, name, namespace));
    const busName = (await waitFor(d, "agent_ok")).bus_name;
    const identity = uniq("ident");
    await sql(
      "update agents set identity_id = ? where machine_id = ? and native_ref = ?",
      identity,
      mach.id,
      ref,
    );
    const [row] = await sql<{ id: string }>(
      "select id from agents where machine_id = ? and native_ref = ?",
      mach.id,
      ref,
    );
    return { ref, name: busName, identity, id: row.id };
  };
  const setRole = async (name: string, agentId: string) => {
    const r = await hub.putRole(namespace, name, agentId);
    if (!r.ok) throw new Error(`putRole refused: ${r.reason}`);
    return r;
  };
  /** The hub's clock (ms), so a role's held_since is a known time. */
  const clock = async (ms: number) => {
    clocked.add(m.userId);
    await runInDurableObject(hub, (i) => BusHub.setTestClock(i, ms));
  };
  return { m, d, hub, namespace, reg, setRole, sql, clock };
}
const clocked = new Set<string>();
afterEach(async () => {
  for (const u of clocked)
    await runInDurableObject(await hubOf(u), (i) =>
      BusHub.setTestClock(i, null),
    );
  clocked.clear();
});
type S = Awaited<ReturnType<typeof setup>>;

const ask = async <T extends ServerFrame["type"]>(
  s: S,
  frame: Record<string, unknown>,
  type: T,
): Promise<Reply<T>> => {
  const fid = id("f");
  s.d.send({ v: 1, id: fid, ...frame } as never);
  for (;;) {
    const f = await s.d.next();
    if (f.id === fid) {
      expect(f.type).toBe(type);
      return f as Reply<T>;
    }
  }
};
const follow = (s: S, ref: string, artifact: string) =>
  ask(s, { type: "follow", from_ref: ref, artifact }, "followed");
const listed = async (s: S, ref: string) =>
  (await ask(s, { type: "following", from_ref: ref }, "follows")).follows.map(
    (f) => f.artifact_id,
  );

/** The hub's own role texts (#3132): a move, a takeover ask. */
const isRoleText = (f: ServerFrame) =>
  f.type === "deliver" &&
  /^(Your role "|A proposal would move your role ")/.test(f.body ?? "");
/** The next deliver frame that is a page notice, past the hub's role texts. */
async function pageNotice(s: S): Promise<Reply<"deliver">> {
  for (;;) {
    const f = await s.d.next();
    if (f.type === "deliver" && !isRoleText(f)) return f;
  }
}
/** The next hub role text for agent `ref`. */
async function roleText(s: S, ref: string): Promise<string> {
  for (;;) {
    const f = await s.d.next();
    if (isRoleText(f) && f.type === "deliver" && f.to_ref === ref)
      return f.body ?? "";
  }
}

const note = (
  to: { namespace: string; name: string },
  over: Partial<BusNotice> = {},
): BusNotice => {
  const artifactId = over.artifactId ?? uniq("art");
  const url = `https://app.test/a/${artifactId}`;
  return {
    id: newId(),
    kind: "comment",
    from: NOTICE_SENDER,
    artifactId,
    version: 1,
    url,
    to,
    text: noticeText("shared", 1, url),
    coalesceKey: artifactId,
    ...over,
  };
};

const owner = async (userId: string): Promise<Member> => {
  const u = await getUser(e, userId);
  if (!u) throw new Error("no user");
  return u;
};
const artifactOf = async (userId: string) =>
  (
    await publish(
      e,
      await owner(userId),
      { title: "t", format: "markdown", content: "hello" } as never,
      null,
      undefined,
      "create",
    )
  ).id;

describe("a moved role takes the old session's notices along (#3132)", () => {
  it("an answer to an ask posted while it held the role reaches the new holder", async () => {
    const s = await setup();
    const old = await s.reg(uniq("plat-l"));
    const next = await s.reg(uniq("plat-w"));
    const role = uniq("platform");
    const t0 = Date.now() - 60_000;
    await s.clock(t0);
    await s.setRole(role, old.id);
    await s.clock(t0 + 30_000);
    const moved = await s.setRole(role, next.id);
    expect(moved.moved).toMatchObject({
      fromAgentId: old.id,
      toAgentId: next.id,
      heldFrom: t0,
      from: { namespace: s.namespace, name: old.name },
      to: { namespace: s.namespace, name: next.name },
    });
    const n = note(
      { namespace: s.namespace, name: old.name },
      { toIdentity: old.identity, originAt: t0 + 10_000 },
    );
    expect(await s.hub.deliverNotice(n)).toBe("delivered");
    const dl = await pageNotice(s);
    expect(dl.to_ref).toBe(next.ref);
    expect(dl.body).toBe(n.text);
    // The Worker's lookup for a session gone from the hub answers the same.
    expect(await s.hub.roleHolderFor(old.identity, t0 + 10_000)).toEqual({
      namespace: s.namespace,
      name: next.name,
      identityId: next.identity,
    });
  });

  it("an answer to an ask it posted before it held the role stays its own", async () => {
    const s = await setup();
    const old = await s.reg(uniq("plat-l"));
    const next = await s.reg(uniq("plat-w"));
    const role = uniq("platform");
    const t0 = Date.now() + 60_000;
    await s.clock(t0);
    await s.setRole(role, old.id);
    await s.setRole(role, next.id);
    const n = note(
      { namespace: s.namespace, name: old.name },
      { toIdentity: old.identity, originAt: t0 - 1 },
    );
    expect(await s.hub.deliverNotice(n)).toBe("delivered");
    expect((await pageNotice(s)).to_ref).toBe(old.ref);
    expect(await s.hub.roleHolderFor(old.identity, t0 - 1)).toBeNull();
  });

  it("an answer to an ask it posted after it handed the role on stays its own", async () => {
    const s = await setup();
    const old = await s.reg(uniq("plat-l"));
    const next = await s.reg(uniq("plat-w"));
    const role = uniq("platform");
    const t0 = Date.now() - 60_000;
    await s.clock(t0);
    await s.setRole(role, old.id);
    await s.clock(t0 + 30_000);
    await s.setRole(role, next.id);
    const n = note(
      { namespace: s.namespace, name: old.name },
      { toIdentity: old.identity, originAt: t0 + 30_001 },
    );
    expect(await s.hub.deliverNotice(n)).toBe("delivered");
    expect((await pageNotice(s)).to_ref).toBe(old.ref);
    expect(await s.hub.roleHolderFor(old.identity, t0 + 30_001)).toBeNull();
  });

  it("a mention of the old session's name after the move reaches the new holder once the old one closed", async () => {
    const s = await setup();
    const old = await s.reg(uniq("plat-l"));
    const next = await s.reg(uniq("plat-w"));
    const role = uniq("platform");
    await s.setRole(role, old.id);
    await s.setRole(role, next.id);
    s.d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: old.ref });
    await ask(s, { type: "list", from_ref: next.ref }, "roster");
    const n = note({ namespace: s.namespace, name: old.name });
    expect(await s.hub.deliverNotice(n)).toBe("delivered");
    expect((await pageNotice(s)).to_ref).toBe(next.ref);
  });

  it("only the pages it began to follow while it held the role move; the rest stay, and notices go where the follow is", async () => {
    const s = await setup();
    const before = await artifactOf(s.m.userId);
    const during = await artifactOf(s.m.userId);
    const old = await s.reg(uniq("plat-l"));
    const next = await s.reg(uniq("plat-w"));
    const role = uniq("platform");
    const t0 = Date.now() - 60_000;
    await follow(s, old.ref, before);
    await follow(s, old.ref, during);
    // Explicit times: one follow before the role, one while it was held.
    await e.DB.batch([
      e.DB.prepare(
        "update follows set created_at = ? where user_id = ? and artifact_id = ?",
      ).bind(t0 - 1, s.m.userId, before),
      e.DB.prepare(
        "update follows set created_at = ? where user_id = ? and artifact_id = ?",
      ).bind(t0 + 1, s.m.userId, during),
    ]);
    await s.clock(t0);
    await s.setRole(role, old.id);
    await s.clock(t0 + 30_000);
    await s.setRole(role, next.id);
    // following waits for the hub's queued re-key.
    expect(await listed(s, next.ref)).toEqual([during]);
    expect(await listed(s, old.ref)).toEqual([before]);
    await notifyChanged(e, during, 2, s.m.userId, Date.now());
    expect((await pageNotice(s)).to_ref).toBe(next.ref);
    await notifyChanged(e, before, 2, s.m.userId, Date.now());
    expect((await pageNotice(s)).to_ref).toBe(old.ref);
  });

  it("over two hand-offs (A to B to C), A's follows and ask answer reach C; B's own older follow stays B's", async () => {
    const s = await setup();
    const inherited = await artifactOf(s.m.userId);
    const bOwn = await artifactOf(s.m.userId);
    const a = await s.reg(uniq("a"));
    const b = await s.reg(uniq("b"));
    const c = await s.reg(uniq("c"));
    const role = uniq("platform");
    const t0 = Date.now() - 600_000;
    await follow(s, a.ref, inherited);
    await follow(s, b.ref, bOwn);
    await e.DB.batch([
      e.DB.prepare(
        "update follows set created_at = ? where user_id = ? and artifact_id = ?",
      ).bind(t0 + 1, s.m.userId, inherited),
      e.DB.prepare(
        "update follows set created_at = ? where user_id = ? and artifact_id = ?",
      ).bind(t0 - 1, s.m.userId, bOwn),
    ]);
    await s.clock(t0);
    await s.setRole(role, a.id);
    await s.clock(t0 + 60_000);
    await s.setRole(role, b.id);
    expect((await listed(s, b.ref)).sort()).toEqual([inherited, bOwn].sort());
    await s.clock(t0 + 120_000);
    await s.setRole(role, c.id);
    expect(await listed(s, c.ref)).toEqual([inherited]);
    expect(await listed(s, b.ref)).toEqual([bOwn]);
    expect(await listed(s, a.ref)).toEqual([]);
    await notifyChanged(e, inherited, 2, s.m.userId, Date.now());
    expect((await pageNotice(s)).to_ref).toBe(c.ref);
    // An ask A posted while it held the role: its answer reaches C now.
    const n = note(
      { namespace: s.namespace, name: a.name },
      { toIdentity: a.identity, originAt: t0 + 30_000 },
    );
    expect(await s.hub.deliverNotice(n)).toBe("delivered");
    expect((await pageNotice(s)).to_ref).toBe(c.ref);
  });

  it("a page both the role and its next holder follow keeps both: on the next move the role's part goes on, the holder's own stays", async () => {
    const s = await setup();
    const x = await artifactOf(s.m.userId);
    const a = await s.reg(uniq("a"));
    const b = await s.reg(uniq("b"));
    const c = await s.reg(uniq("c"));
    const role = uniq("platform");
    const t0 = Date.now() - 600_000;
    await follow(s, b.ref, x);
    await follow(s, a.ref, x);
    await e.DB.batch([
      e.DB.prepare(
        "update follows set created_at = ? where user_id = ? and artifact_id = ? and agent_name = ?",
      ).bind(t0 - 1, s.m.userId, x, b.name),
      e.DB.prepare(
        "update follows set created_at = ? where user_id = ? and artifact_id = ? and agent_name = ?",
      ).bind(t0 + 1, s.m.userId, x, a.name),
    ]);
    await s.clock(t0);
    await s.setRole(role, a.id);
    await s.clock(t0 + 60_000);
    await s.setRole(role, b.id);
    expect(await listed(s, b.ref)).toEqual([x]);
    expect(await listed(s, a.ref)).toEqual([]);
    await s.clock(t0 + 120_000);
    await s.setRole(role, c.id);
    expect(await listed(s, c.ref)).toEqual([x]);
    expect(await listed(s, b.ref)).toEqual([x]);
    // One notice each: B for its own follow, C for the role's.
    await notifyChanged(e, x, 2, s.m.userId, Date.now());
    const got = [
      (await pageNotice(s)).to_ref,
      (await pageNotice(s)).to_ref,
    ].sort();
    expect(got).toEqual([b.ref, c.ref].sort());
  });

  it("the holder unfollowing a page it shares with the role ends both: the next move gives it to nobody", async () => {
    const s = await setup();
    const x = await artifactOf(s.m.userId);
    const a = await s.reg(uniq("a"));
    const b = await s.reg(uniq("b"));
    const c = await s.reg(uniq("c"));
    const role = uniq("platform");
    const t0 = Date.now() - 600_000;
    await follow(s, b.ref, x);
    await follow(s, a.ref, x);
    await e.DB.batch([
      e.DB.prepare(
        "update follows set created_at = ? where user_id = ? and artifact_id = ? and agent_name = ?",
      ).bind(t0 - 1, s.m.userId, x, b.name),
      e.DB.prepare(
        "update follows set created_at = ? where user_id = ? and artifact_id = ? and agent_name = ?",
      ).bind(t0 + 1, s.m.userId, x, a.name),
    ]);
    await s.clock(t0);
    await s.setRole(role, a.id);
    await s.clock(t0 + 60_000);
    await s.setRole(role, b.id);
    expect(await listed(s, b.ref)).toEqual([x]);
    expect(
      (
        await ask(
          s,
          { type: "unfollow", from_ref: b.ref, artifact: x },
          "unfollowed",
        )
      ).removed,
    ).toBe(true);
    await s.clock(t0 + 120_000);
    await s.setRole(role, c.id);
    expect(await listed(s, c.ref)).toEqual([]);
    expect(await listed(s, b.ref)).toEqual([]);
  });

  it("an unfollow still in flight when the role moves on gives the page to nobody", async () => {
    const s = await setup();
    const x = await artifactOf(s.m.userId);
    const a = await s.reg(uniq("a"));
    const b = await s.reg(uniq("b"));
    const c = await s.reg(uniq("c"));
    const role = uniq("platform");
    const t0 = Date.now() - 600_000;
    await follow(s, b.ref, x);
    await follow(s, a.ref, x);
    await e.DB.batch([
      e.DB.prepare(
        "update follows set created_at = ? where user_id = ? and artifact_id = ? and agent_name = ?",
      ).bind(t0 - 1, s.m.userId, x, b.name),
      e.DB.prepare(
        "update follows set created_at = ? where user_id = ? and artifact_id = ? and agent_name = ?",
      ).bind(t0 + 1, s.m.userId, x, a.name),
    ]);
    await s.clock(t0);
    await s.setRole(role, a.id);
    await s.clock(t0 + 60_000);
    await s.setRole(role, b.id);
    expect(await listed(s, b.ref)).toEqual([x]);
    // The queued follow work (the unfollow's D1 delete) is held while the
    // role moves on, then let go.
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await runInDurableObject(s.hub, (i) => BusHub.setTestFollowGate(i, gate));
    const u = id("f");
    s.d.send({
      v: 1,
      id: u,
      type: "unfollow",
      from_ref: b.ref,
      artifact: x,
    } as never);
    await ask(s, { type: "list", from_ref: b.ref }, "roster");
    await s.clock(t0 + 120_000);
    await s.setRole(role, c.id);
    release();
    await runInDurableObject(s.hub, (i) => BusHub.setTestFollowGate(i, null));
    expect(await listed(s, c.ref)).toEqual([]);
    expect(await listed(s, b.ref)).toEqual([]);
  });

  it("an unfollow received while a move's re-key is pending keeps its place: a later move gives the page to nobody", async () => {
    const s = await setup();
    const x = await artifactOf(s.m.userId);
    const a = await s.reg(uniq("a"));
    const b = await s.reg(uniq("b"));
    const c = await s.reg(uniq("c"));
    const role = uniq("platform");
    const t0 = Date.now() - 600_000;
    // A role-only follow: A follows X while it holds the role.
    await follow(s, a.ref, x);
    await e.DB.prepare(
      "update follows set created_at = ? where user_id = ? and artifact_id = ? and agent_name = ?",
    )
      .bind(t0 + 1, s.m.userId, x, a.name)
      .run();
    await s.clock(t0);
    await s.setRole(role, a.id);
    // Hold the follow queue: A to B's re-key is pending.
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await runInDurableObject(s.hub, (i) => BusHub.setTestFollowGate(i, gate));
    await s.clock(t0 + 60_000);
    await s.setRole(role, b.id);
    // B unfollows X now (the frame is handled: a later frame's reply proves
    // it), then the role moves on to C, all before the queue runs.
    s.d.send({
      v: 1,
      id: id("f"),
      type: "unfollow",
      from_ref: b.ref,
      artifact: x,
    } as never);
    await ask(s, { type: "list", from_ref: b.ref }, "roster");
    await s.clock(t0 + 120_000);
    await s.setRole(role, c.id);
    release();
    await runInDurableObject(s.hub, (i) => BusHub.setTestFollowGate(i, null));
    expect(await listed(s, c.ref)).toEqual([]);
    expect(await listed(s, b.ref)).toEqual([]);
    expect(await listed(s, a.ref)).toEqual([]);
  });

  it("an unfollow of a page the holder also follows, received while A to B's re-key is pending, ends the role's part the re-key adds", async () => {
    const s = await setup();
    const x = await artifactOf(s.m.userId);
    const a = await s.reg(uniq("a"));
    const b = await s.reg(uniq("b"));
    const c = await s.reg(uniq("c"));
    const role = uniq("platform");
    const t0 = Date.now() - 600_000;
    await follow(s, b.ref, x);
    await follow(s, a.ref, x);
    await e.DB.batch([
      e.DB.prepare(
        "update follows set created_at = ? where user_id = ? and artifact_id = ? and agent_name = ?",
      ).bind(t0 - 1, s.m.userId, x, b.name),
      e.DB.prepare(
        "update follows set created_at = ? where user_id = ? and artifact_id = ? and agent_name = ?",
      ).bind(t0 + 1, s.m.userId, x, a.name),
    ]);
    await s.clock(t0);
    await s.setRole(role, a.id);
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await runInDurableObject(s.hub, (i) => BusHub.setTestFollowGate(i, gate));
    await s.clock(t0 + 60_000);
    await s.setRole(role, b.id);
    s.d.send({
      v: 1,
      id: id("f"),
      type: "unfollow",
      from_ref: b.ref,
      artifact: x,
    } as never);
    await ask(s, { type: "list", from_ref: b.ref }, "roster");
    await s.clock(t0 + 120_000);
    await s.setRole(role, c.id);
    release();
    await runInDurableObject(s.hub, (i) => BusHub.setTestFollowGate(i, null));
    expect(await listed(s, c.ref)).toEqual([]);
    expect(await listed(s, b.ref)).toEqual([]);
    expect(await listed(s, a.ref)).toEqual([]);
  });

  it("an unfollow whose delete fails keeps the role's part: the next move still hands the page on", async () => {
    const s = await setup();
    const x = await artifactOf(s.m.userId);
    const a = await s.reg(uniq("a"));
    const b = await s.reg(uniq("b"));
    const c = await s.reg(uniq("c"));
    const role = uniq("platform");
    const t0 = Date.now() - 600_000;
    await follow(s, b.ref, x);
    await follow(s, a.ref, x);
    await e.DB.batch([
      e.DB.prepare(
        "update follows set created_at = ? where user_id = ? and artifact_id = ? and agent_name = ?",
      ).bind(t0 - 1, s.m.userId, x, b.name),
      e.DB.prepare(
        "update follows set created_at = ? where user_id = ? and artifact_id = ? and agent_name = ?",
      ).bind(t0 + 1, s.m.userId, x, a.name),
    ]);
    await s.clock(t0);
    await s.setRole(role, a.id);
    await s.clock(t0 + 60_000);
    await s.setRole(role, b.id);
    expect(await listed(s, b.ref)).toEqual([x]);
    // The D1 delete fails: the unfollow is refused and nothing changes.
    await e.DB.prepare("alter table follows rename to follows_x").run();
    try {
      s.d.send({
        v: 1,
        id: id("f"),
        type: "unfollow",
        from_ref: b.ref,
        artifact: x,
      } as never);
      expect((await waitFor(s.d, "error")).code).toBe("internal");
    } finally {
      await e.DB.prepare("alter table follows_x rename to follows").run();
    }
    await s.clock(t0 + 120_000);
    await s.setRole(role, c.id);
    expect(await listed(s, c.ref)).toEqual([x]);
    expect(await listed(s, b.ref)).toEqual([x]);
  });

  it("a session that still holds another role keeps its mail", async () => {
    const s = await setup();
    const a = await s.reg(uniq("a"));
    const b = await s.reg(uniq("b"));
    const r1 = uniq("one");
    const r2 = uniq("two");
    await s.setRole(r1, a.id);
    await s.setRole(r2, a.id);
    await s.setRole(r1, b.id);
    const n = note(
      { namespace: s.namespace, name: a.name },
      { toIdentity: a.identity },
    );
    expect(await s.hub.deliverNotice(n)).toBe("delivered");
    expect((await pageNotice(s)).to_ref).toBe(a.ref);
  });

  it("a holder's earlier move never takes the mail of the role it holds now", async () => {
    const s = await setup();
    const a = await s.reg(uniq("a"));
    const b = await s.reg(uniq("b"));
    const c = await s.reg(uniq("c"));
    const r0 = uniq("zero");
    const r = uniq("platform");
    await s.setRole(r0, b.id);
    await s.setRole(r0, c.id);
    await s.setRole(r, a.id);
    await s.setRole(r, b.id);
    // A follow notice now addressed to b (its rows moved there) stays with b.
    const n = note({ namespace: s.namespace, name: b.name });
    expect(await s.hub.deliverNotice(n)).toBe("delivered");
    expect((await pageNotice(s)).to_ref).toBe(b.ref);
    // And a's mail goes to b, the holder of a's role, not on to c.
    const m = note({ namespace: s.namespace, name: a.name });
    expect(await s.hub.deliverNotice(m)).toBe("delivered");
    expect((await pageNotice(s)).to_ref).toBe(b.ref);
    expect(
      framesSeen(s.d).filter((f) => f.type === "deliver" && !isRoleText(f)),
    ).toHaveLength(2);
  });

  it("a namesake of the old session gets its own mail, not the role's", async () => {
    const s = await setup();
    const old = await s.reg(uniq("plat-l"));
    const next = await s.reg(uniq("plat-w"));
    const role = uniq("platform");
    await s.setRole(role, old.id);
    await s.setRole(role, next.id);
    // The old session is gone for good and its name is free again.
    s.d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: old.ref });
    await ask(s, { type: "list", from_ref: next.ref }, "roster");
    await s.sql("delete from former_names where agent_id = ?", old.id);
    await s.sql("delete from agents where id = ?", old.id);
    const namesake = await s.reg(old.name);
    expect(namesake.name).toBe(old.name);
    const n = note({ namespace: s.namespace, name: old.name });
    expect(await s.hub.deliverNotice(n)).toBe("delivered");
    expect((await pageNotice(s)).to_ref).toBe(namesake.ref);
  });

  it("a session that holds the role again gets its mail again", async () => {
    const s = await setup();
    const a = await s.reg(uniq("a"));
    const b = await s.reg(uniq("b"));
    const role = uniq("platform");
    await s.setRole(role, a.id);
    await s.setRole(role, b.id);
    await s.setRole(role, a.id);
    const n = note(
      { namespace: s.namespace, name: a.name },
      { toIdentity: a.identity },
    );
    expect(await s.hub.deliverNotice(n)).toBe("delivered");
    expect((await pageNotice(s)).to_ref).toBe(a.ref);
  });

  it("without a move, delivery is as addressed; a vacated role forwards nothing", async () => {
    const s = await setup();
    const a = await s.reg(uniq("a"));
    const b = await s.reg(uniq("b"));
    const role = uniq("platform");
    const set = await s.setRole(role, a.id);
    expect(set.moved).toBeNull();
    await s.setRole(role, b.id);
    const vacated = await s.hub.putRole(s.namespace, role, null);
    expect(vacated.ok && vacated.moved).toBeNull();
    const n = note({ namespace: s.namespace, name: a.name });
    expect(await s.hub.deliverNotice(n)).toBe("delivered");
    expect((await pageNotice(s)).to_ref).toBe(a.ref);
  });

  it("the old session, still open, is told its role moved", async () => {
    const s = await setup();
    const old = await s.reg(uniq("plat-l"));
    const next = await s.reg(uniq("plat-w"));
    const role = uniq("platform");
    await s.setRole(role, old.id);
    await s.setRole(role, next.id);
    expect(await roleText(s, old.ref)).toBe(
      `Your role "${role}" moved to ${next.name}. What you began while you held it (open asks, followed pages) and new mentions of you go there now.`,
    );
  });

  it("an unlinked proposal names the intended holder without attributing the request to it", async () => {
    const s = await setup();
    const old = await s.reg(uniq("plat-l"));
    const next = await s.reg(uniq("plat-w"));
    const role = uniq("platform");
    await s.setRole(role, old.id);
    const p = await s.hub.proposeRole(
      {
        action: "set",
        namespace: s.namespace,
        name: role,
        agent: next.name,
        credential: null,
      },
      uniq("hash"),
    );
    expect(p.ok).toBe(true);
    const text = await roleText(s, old.ref);
    expect(text).toBe(
      `A proposal would move your role "${role}" in ${s.namespace} to ${next.name}. To hand it over now, with its open asks, mentions and followed pages, call bus_role_propose with action "set", namespace "${s.namespace}", name "${role}" and agent "${next.name}".`,
    );
    // Nothing moved: only the person's confirm, or the holder, moves it.
    const [r] = (await s.hub.listRoles()).filter((x) => x.name === role);
    expect(r?.holderName).toBe(old.name);
  });
});
