// #1822: link_bind (BUS_CAPS.link) and the hub's proof lookup. A real hub and
// real daemon sockets. A bind is accepted only for an agent the socket
// registered; a new bind replaces the old hash; a close clears it; the
// identity_id survives a rename and moves with a reclaimed name on the same
// machine only. Waits are signals (the reply frame), never sleeps; time is
// BusHub.setTestClock, reset after each test.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { BUS_CAPS, type ClientFrame } from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import {
  BusHub,
  OFFLINE_REAP_MS,
  PROOF_AWAY_GRACE_MS,
} from "../../src/bus/hub.js";
import { migrateHub } from "../../src/bus/schema.js";
import {
  type Daemon,
  daemon,
  hello,
  hubOf,
  machine,
  member,
  ns,
  up,
  waitFor,
} from "./helpers.js";

let seq = 0;
const id = (t: string) => `${t}${++seq}`;
const hashOf = (c: string) => c.repeat(64).slice(0, 64);

const setClock = async (userId: string, ms: number | null) =>
  runInDurableObject(await hubOf(userId), (i: BusHub) =>
    BusHub.setTestClock(i, ms),
  );

async function lookup(userId: string, hash: string) {
  return runInDurableObject(await hubOf(userId), (i: BusHub) =>
    i.agentByProof(hash),
  );
}

async function rows(userId: string, q: string, ...b: SqlStorageValue[]) {
  return runInDurableObject(
    await hubOf(userId),
    (_: BusHub, s: DurableObjectState) =>
      s.storage.sql.exec(q, ...b).toArray() as Record<string, unknown>[],
  );
}

async function connect(token: string, caps: string[] | null) {
  const d = await daemon(token);
  d.send({ ...hello(id("h")), ...(caps ? { caps } : {}) } as ClientFrame);
  await waitFor(d, "hello_ok");
  return d;
}

async function reg(d: Daemon, ref: string, name: string, namespace: string) {
  d.send(up(id("u"), ref, name, namespace));
  return (await waitFor(d, "agent_ok")).bus_name;
}

/** link_bind; resolves with the `link_bound` or `error` that answers it. */
async function bind(d: Daemon, ref: string, hash: string) {
  const fid = id("b");
  d.send({ v: 1, id: fid, type: "link_bind", agent_ref: ref, hash } as never);
  for (;;) {
    const f = await d.next();
    if ((f.type === "link_bound" || f.type === "error") && f.id === fid)
      return f;
  }
}

async function scene(caps: string[] | null = [BUS_CAPS.link]) {
  const m = await member();
  const mach = await machine("Laptop", m.userId);
  const d = await connect(mach.token, caps);
  return { m, mach, d, ns: ns("link") };
}

const close = async (d: Daemon, userId: string, ref: string) => {
  d.send({ v: 1, id: id("c"), type: "sessions", open: [], closed: [ref] });
  for (;;) {
    const r = await rows(
      userId,
      "select live from agents where native_ref = ? order by rowid desc limit 1",
      ref,
    );
    if (r[0]?.live === 0) return;
    await new Promise((res) => setTimeout(res, 5));
  }
};

describe("link_arg cap (#1856)", () => {
  it("hello_ok lists link_arg: this hub's /mcp strips the proof argument", async () => {
    const m = await member();
    const mach = await machine("Laptop", m.userId);
    const d = await daemon(mach.token);
    d.send({ ...hello(id("h")), caps: [BUS_CAPS.link] } as ClientFrame);
    const ok = await waitFor(d, "hello_ok");
    expect(ok.caps).toEqual(
      expect.arrayContaining([BUS_CAPS.link, BUS_CAPS.linkArg]),
    );
  });
});

async function identityOf(userId: string, namespace: string, name: string) {
  return runInDurableObject(await hubOf(userId), (i: BusHub) =>
    i.identityOf(namespace, name),
  );
}

describe("identityOf (#1890)", () => {
  it("returns only the identity id and kind, for a live or an away agent", async () => {
    const s = await scene();
    const name = await reg(s.d, "r1", "Lead", s.ns);
    expect(await identityOf(s.m.userId, s.ns, name)).toBeNull();
    await bind(s.d, "r1", hashOf("a"));
    const live = await identityOf(s.m.userId, s.ns, name);
    expect(Object.keys(live ?? {}).sort()).toEqual(["identityId", "kind"]);
    expect(live?.kind).toBe("opencode");
    await close(s.d, s.m.userId, "r1");
    expect(await identityOf(s.m.userId, s.ns, name)).toEqual(live);
    expect(await identityOf(s.m.userId, s.ns, "nobody")).toBeNull();
    expect(await identityOf(s.m.userId, "other-ns", name)).toBeNull();
  });
  it("never resolves another member's agent", async () => {
    const a = await scene();
    const name = await reg(a.d, "r1", "Lead", a.ns);
    await bind(a.d, "r1", hashOf("a"));
    const b = await member();
    expect(await identityOf(b.userId, a.ns, name)).toBeNull();
  });
});

/** Binds hashOf("1".."4") to `ref`; returns them. */
async function bindMany(
  s: { d: Daemon; m: { userId: string } },
  ref: string,
  n = 4,
) {
  const hs = Array.from({ length: n }, (_, i) => hashOf("1234"[i] as string));
  for (const h of hs) await bind(s.d, ref, h);
  for (const h of hs) expect(await lookup(s.m.userId, h)).not.toBeNull();
  return hs;
}
const allGone = async (userId: string, hs: string[]) => {
  for (const h of hs) expect(await lookup(userId, h)).toBeNull();
  expect(await rows(userId, "select count(*) as n from agent_proofs")).toEqual([
    { n: 0 },
  ]);
};

describe("link_bind (#1822)", () => {
  it("binds the agent the socket registered; the hash resolves to its session", async () => {
    const s = await scene();
    const name = await reg(s.d, "r1", "Lead", s.ns);
    const r = await bind(s.d, "r1", hashOf("a"));
    expect(r.type).toBe("link_bound");
    const got = await lookup(s.m.userId, hashOf("a"));
    expect(got).toMatchObject({ namespace: s.ns, name, kind: "opencode" });
    expect(got?.identityId).toMatch(/^[0-9a-f]{32}$/);
    expect(await lookup(s.m.userId, hashOf("b"))).toBeNull();
  });

  it("refuses a bind from a machine that did not register the agent", async () => {
    const s = await scene();
    await reg(s.d, "r-own", "Lead", s.ns);
    const other = await machine("Other", s.m.userId);
    const d2 = await connect(other.token, [BUS_CAPS.link]);
    const r = await bind(d2, "r-own", hashOf("c"));
    expect(r).toMatchObject({ type: "error", code: "not_registered" });
    expect(await lookup(s.m.userId, hashOf("c"))).toBeNull();
    expect(
      await rows(
        s.m.userId,
        "select 1 from agents where proof_hash is not null",
      ),
    ).toEqual([]);
  });

  it("is bad_frame without the cap", async () => {
    const s = await scene(null);
    await reg(s.d, "r1", "Lead", s.ns);
    const r = await bind(s.d, "r1", hashOf("d"));
    expect(r).toMatchObject({ type: "error", code: "bad_frame" });
    expect(await lookup(s.m.userId, hashOf("d"))).toBeNull();
  });

  it("a second bind ADDS a proof: both resolve to the session, one identity (#1984)", async () => {
    const s = await scene();
    await reg(s.d, "r1", "Lead", s.ns);
    await bind(s.d, "r1", hashOf("1"));
    const first = await lookup(s.m.userId, hashOf("1"));
    await bind(s.d, "r1", hashOf("2"));
    const old = await lookup(s.m.userId, hashOf("1"));
    const fresh = await lookup(s.m.userId, hashOf("2"));
    expect(old).toEqual(first);
    expect(fresh?.identityId).toBe(first?.identityId);
    expect(fresh?.name).toBe(first?.name);
  });

  it("a fifth bind evicts the oldest proof (#1984)", async () => {
    const s = await scene();
    await reg(s.d, "r1", "Lead", s.ns);
    for (const c of ["1", "2", "3", "4", "5"]) await bind(s.d, "r1", hashOf(c));
    expect(await lookup(s.m.userId, hashOf("1"))).toBeNull();
    for (const c of ["2", "3", "4", "5"])
      expect(await lookup(s.m.userId, hashOf(c))).not.toBeNull();
    // Re-binding a held proof refreshes it, so it outlives a newer one.
    await bind(s.d, "r1", hashOf("2"));
    await bind(s.d, "r1", hashOf("6"));
    expect(await lookup(s.m.userId, hashOf("3"))).toBeNull();
    expect(await lookup(s.m.userId, hashOf("2"))).not.toBeNull();
  });

  it("another session's proof never matches this session (#1984)", async () => {
    const s = await scene();
    await reg(s.d, "r1", "Lead", s.ns);
    await reg(s.d, "r2", "Other", s.ns);
    await bind(s.d, "r1", hashOf("1"));
    await bind(s.d, "r1", hashOf("2"));
    await bind(s.d, "r2", hashOf("3"));
    const a = await lookup(s.m.userId, hashOf("1"));
    const b = await lookup(s.m.userId, hashOf("3"));
    expect((await lookup(s.m.userId, hashOf("2")))?.name).toBe(a?.name);
    expect(a?.name).not.toBe(b?.name);
    expect(a?.identityId).not.toBe(b?.identityId);
  });

  it("closing the session unlinks every proof after the away grace, and a later reopen does not revive them (#1984, #2110)", async () => {
    const s = await scene();
    const t0 = Date.now() + 3_600_000 + ++seq * 1000;
    await setClock(s.m.userId, t0);
    await reg(s.d, "r1", "Lead", s.ns);
    await bind(s.d, "r1", hashOf("1"));
    await bind(s.d, "r1", hashOf("2"));
    await close(s.d, s.m.userId, "r1");
    await setClock(s.m.userId, t0 + PROOF_AWAY_GRACE_MS);
    expect(await lookup(s.m.userId, hashOf("1"))).toBeNull();
    expect(await lookup(s.m.userId, hashOf("2"))).toBeNull();
    await reg(s.d, "r1", "Lead", s.ns);
    expect(await lookup(s.m.userId, hashOf("1"))).toBeNull();
    expect(await lookup(s.m.userId, hashOf("2"))).toBeNull();
    expect(
      await rows(s.m.userId, "select count(*) as n from agent_proofs"),
    ).toEqual([{ n: 0 }]);
    await setClock(s.m.userId, null);
  });

  it("closing the session clears the hash column; its proofs wait out the away grace (#2110)", async () => {
    const s = await scene();
    await reg(s.d, "r1", "Lead", s.ns);
    await bind(s.d, "r1", hashOf("3"));
    expect(await lookup(s.m.userId, hashOf("3"))).not.toBeNull();
    await close(s.d, s.m.userId, "r1");
    expect(
      await rows(
        s.m.userId,
        "select proof_hash from agents where native_ref = 'r1'",
      ),
    ).toEqual([{ proof_hash: null }]);
    expect(await lookup(s.m.userId, hashOf("3"))).not.toBeNull();
  });

  it("a rename keeps identity_id and the lookup shows the new name", async () => {
    const s = await scene([BUS_CAPS.link, BUS_CAPS.rename]);
    await reg(s.d, "r1", "Lead", s.ns);
    await bind(s.d, "r1", hashOf("4"));
    const before = await lookup(s.m.userId, hashOf("4"));
    s.d.send({
      v: 1,
      id: id("rn"),
      type: "rename",
      agent_ref: "r1",
      proposed_name: "Captain",
    } as ClientFrame);
    await waitFor(s.d, "renamed");
    const after = await lookup(s.m.userId, hashOf("4"));
    expect(after?.name).toBe("Captain");
    expect(after?.identityId).toBe(before?.identityId);
  });

  it("a rename keeps all of the session's proofs (#1984)", async () => {
    const s = await scene([BUS_CAPS.link, BUS_CAPS.rename]);
    await reg(s.d, "r1", "Lead", s.ns);
    const hs = await bindMany(s, "r1", 3);
    s.d.send({
      v: 1,
      id: id("rn"),
      type: "rename",
      agent_ref: "r1",
      proposed_name: "Captain",
    } as ClientFrame);
    await waitFor(s.d, "renamed");
    for (const h of hs)
      expect((await lookup(s.m.userId, h))?.name).toBe("Captain");
  });

  it("a malformed hash is refused at the frame; the lookup of one gives null", async () => {
    const s = await scene();
    await reg(s.d, "r1", "Lead", s.ns);
    const r = await bind(s.d, "r1", "not-a-hash");
    expect(r).toMatchObject({ type: "error", code: "bad_frame" });
    expect(await lookup(s.m.userId, "not-a-hash")).toBeNull();
  });
});

describe("identity_id and a reclaimed name (#1822, #1742)", () => {
  async function restart(sameMachine: boolean) {
    const s = await scene();
    await setClock(s.m.userId, Date.now() + 3_600_000);
    const name = `Lead-${++seq}x`;
    await reg(s.d, "old", name, s.ns);
    await bind(s.d, "old", hashOf("5"));
    const before = await lookup(s.m.userId, hashOf("5"));
    await close(s.d, s.m.userId, "old");
    let d = s.d;
    if (!sameMachine) {
      const other = await machine("Other", s.m.userId);
      d = await connect(other.token, [BUS_CAPS.link]);
    }
    expect(await reg(d, "new", name, s.ns)).toBe(name);
    await bind(d, "new", hashOf("6"));
    return { s, before, after: await lookup(s.m.userId, hashOf("6")) };
  }

  it("moves with the name to the restarted session on the same machine", async () => {
    const { s, before, after } = await restart(true);
    expect(after?.identityId).toBe(before?.identityId);
    // #2110: the old row's identity is unlinked, so its proof ends inside
    // the away grace too.
    expect(await lookup(s.m.userId, hashOf("5"))).toBeNull();
    expect(
      await rows(
        s.m.userId,
        "select identity_id from agents where native_ref = 'old'",
      ),
    ).toEqual([{ identity_id: null }]);
    await setClock(s.m.userId, null);
  });

  it("does not move to a session on another machine", async () => {
    const { s, before, after } = await restart(false);
    expect(after?.identityId).toBeDefined();
    expect(after?.identityId).not.toBe(before?.identityId);
    await setClock(s.m.userId, null);
  });
});

// Every way a session's link ends takes its proof hash with it (the CLOSE_CLEAR
// of hub.ts), and a hash names one live session.
describe("the proof ends with the session (#1822)", () => {
  const proofRow = (userId: string, ref: string) =>
    rows(
      userId,
      "select proof_hash as p, live from agents where native_ref = ? order by rowid desc limit 1",
      ref,
    );

  it("revoking the machine clears the proof", async () => {
    const s = await scene();
    await reg(s.d, "r1", "Lead", s.ns);
    await bind(s.d, "r1", hashOf("7"));
    expect(await lookup(s.m.userId, hashOf("7"))).not.toBeNull();
    const hub = await hubOf(s.m.userId);
    expect(await hub.revokeMachine(s.mach.id)).toBe(true);
    expect(await lookup(s.m.userId, hashOf("7"))).toBeNull();
    expect(await proofRow(s.m.userId, "r1")).toEqual([{ p: null, live: 0 }]);
  });

  it("every proof ends with the session, however it ends (#1984)", async () => {
    // revoke
    const a = await scene();
    await reg(a.d, "r1", "Lead", a.ns);
    const ha = await bindMany(a, "r1");
    expect(await (await hubOf(a.m.userId)).revokeMachine(a.mach.id)).toBe(true);
    await allGone(a.m.userId, ha);
    // agent_down
    const b = await scene();
    await reg(b.d, "r1", "Lead", b.ns);
    const hb = await bindMany(b, "r1", 3);
    b.d.send({ v: 1, id: id("dn"), type: "agent_down", agent_ref: "r1" });
    for (;;) {
      const r = await proofRow(b.m.userId, "r1");
      if (r[0]?.live === 0) break;
      await new Promise((res) => setTimeout(res, 5));
    }
    await allGone(b.m.userId, hb);
    // takeOver
    const c = await scene([BUS_CAPS.link, BUS_CAPS.mailbox]);
    await reg(c.d, "old", "Lead", c.ns);
    const hc = await bindMany(c, "old", 4);
    c.d.send({
      ...up(id("u"), "new", "Lead", c.ns),
      replaces: "old",
    } as ClientFrame);
    await waitFor(c.d, "agent_ok");
    await allGone(c.m.userId, hc);
  });

  it("the offline sweep drops every proof (#1984)", async () => {
    const s = await scene();
    const t0 = Date.now() + 3_600_000 + ++seq * 1000;
    await setClock(s.m.userId, t0);
    await reg(s.d, "r1", "Lead", s.ns);
    const hs = await bindMany(s, "r1", 3);
    s.d.close();
    await s.d.closed;
    for (;;) {
      const r = await rows(
        s.m.userId,
        "select disconnected_at as t from machines where id = ?",
        s.mach.id,
      );
      if (typeof r[0]?.t === "number") break;
      await new Promise((res) => setTimeout(res, 5));
    }
    await setClock(s.m.userId, t0 + OFFLINE_REAP_MS);
    await runInDurableObject(
      await hubOf(s.m.userId),
      async (_: BusHub, st: DurableObjectState) => {
        if ((await st.storage.getAlarm()) === null)
          await st.storage.setAlarm(t0 + OFFLINE_REAP_MS);
      },
    );
    await runDurableObjectAlarm(await hubOf(s.m.userId));
    await allGone(s.m.userId, hs);
    await setClock(s.m.userId, null);
  });

  it("the cold-start carry-over takes live rows' proof_hash once, never a closed row's (#1984)", async () => {
    const s = await scene();
    await reg(s.d, "live1", "Lead", s.ns);
    await reg(s.d, "gone1", "Other", s.ns);
    await close(s.d, s.m.userId, "gone1");
    const hubStub = await hubOf(s.m.userId);
    // Rows as they were before agent_proofs: a proof_hash and no table row.
    const seed = (hashLive: string, hashGone: string) =>
      runInDurableObject(hubStub, (_: BusHub, st: DurableObjectState) => {
        const sql = st.storage.sql;
        sql.exec("delete from agent_proofs");
        sql.exec(
          "update agents set proof_hash = ?, identity_id = 'i1' where native_ref = 'live1'",
          hashLive,
        );
        sql.exec(
          "update agents set proof_hash = ? where native_ref = 'gone1'",
          hashGone,
        );
      });
    await seed(hashOf("c1"), hashOf("c2"));
    const migrate = () =>
      runInDurableObject(hubStub, (_: BusHub, st: DurableObjectState) =>
        migrateHub(st.storage.sql),
      );
    await migrate();
    expect((await lookup(s.m.userId, hashOf("c1")))?.name).toBeDefined();
    expect(await lookup(s.m.userId, hashOf("c2"))).toBeNull();
    const count = () =>
      rows(s.m.userId, "select hash, seq from agent_proofs order by hash");
    const once = await count();
    expect(once).toHaveLength(1);
    await migrate();
    expect(await count()).toEqual(once);
  });

  it("agent_down clears the proof", async () => {
    const s = await scene();
    await reg(s.d, "r1", "Lead", s.ns);
    await bind(s.d, "r1", hashOf("8"));
    s.d.send({ v: 1, id: id("dn"), type: "agent_down", agent_ref: "r1" });
    for (;;) {
      const r = await proofRow(s.m.userId, "r1");
      if (r[0]?.live === 0) break;
      await new Promise((res) => setTimeout(res, 5));
    }
    expect(await lookup(s.m.userId, hashOf("8"))).toBeNull();
    expect(await proofRow(s.m.userId, "r1")).toEqual([{ p: null, live: 0 }]);
  });

  it("takeOver (a /clear: agent_up with replaces) clears the old session's proof", async () => {
    const s = await scene([BUS_CAPS.link, BUS_CAPS.mailbox]);
    await reg(s.d, "old", "Lead", s.ns);
    await bind(s.d, "old", hashOf("9"));
    expect(await lookup(s.m.userId, hashOf("9"))).not.toBeNull();
    s.d.send({
      ...up(id("u"), "new", "Lead", s.ns),
      replaces: "old",
    } as ClientFrame);
    await waitFor(s.d, "agent_ok");
    expect(await lookup(s.m.userId, hashOf("9"))).toBeNull();
    expect(
      await rows(
        s.m.userId,
        "select count(*) as n from agents where proof_hash is not null",
      ),
    ).toEqual([{ n: 0 }]);
  });

  it("the offline sweep clears the proof", async () => {
    const s = await scene();
    const t0 = Date.now() + 3_600_000 + ++seq * 1000;
    await setClock(s.m.userId, t0);
    await reg(s.d, "r1", "Lead", s.ns);
    await bind(s.d, "r1", hashOf("a"));
    s.d.close();
    await s.d.closed;
    for (;;) {
      const r = await rows(
        s.m.userId,
        "select disconnected_at as t from machines where id = ?",
        s.mach.id,
      );
      if (typeof r[0]?.t === "number") break;
      await new Promise((res) => setTimeout(res, 5));
    }
    // Still linked while the machine is only offline.
    expect(await lookup(s.m.userId, hashOf("a"))).not.toBeNull();
    await setClock(s.m.userId, t0 + OFFLINE_REAP_MS);
    await runInDurableObject(
      await hubOf(s.m.userId),
      async (_: BusHub, st: DurableObjectState) => {
        if ((await st.storage.getAlarm()) === null)
          await st.storage.setAlarm(t0 + OFFLINE_REAP_MS);
      },
    );
    await runDurableObjectAlarm(await hubOf(s.m.userId));
    expect(await proofRow(s.m.userId, "r1")).toEqual([{ p: null, live: 0 }]);
    expect(await lookup(s.m.userId, hashOf("a"))).toBeNull();
    await setClock(s.m.userId, null);
  });

  it("binding a hash another session holds takes it off that session", async () => {
    const s = await scene();
    await reg(s.d, "r1", "Lead", s.ns);
    await reg(s.d, "r2", "Other", s.ns);
    await bind(s.d, "r1", hashOf("b"));
    const first = await lookup(s.m.userId, hashOf("b"));
    await bind(s.d, "r2", hashOf("b"));
    const second = await lookup(s.m.userId, hashOf("b"));
    expect(second?.name).not.toBe(first?.name);
    expect(second?.identityId).not.toBe(first?.identityId);
    expect(await proofRow(s.m.userId, "r1")).toEqual([{ p: null, live: 1 }]);
    expect(
      await rows(
        s.m.userId,
        "select count(*) as n from agents where proof_hash = ?",
        hashOf("b"),
      ),
    ).toEqual([{ n: 1 }]);
  });

  it("the lookup ignores a row that is not live, even if a hash is left on it", async () => {
    const s = await scene();
    await reg(s.d, "r1", "Lead", s.ns);
    await bind(s.d, "r1", hashOf("c"));
    expect(await lookup(s.m.userId, hashOf("c"))).not.toBeNull();
    await rows(
      s.m.userId,
      "update agents set live = 0 where native_ref = 'r1' returning id",
    );
    expect(
      await rows(
        s.m.userId,
        "select proof_hash as p from agents where native_ref = 'r1'",
      ),
    ).toEqual([{ p: hashOf("c") }]);
    expect(await lookup(s.m.userId, hashOf("c"))).toBeNull();
  });
});

async function namesOf(userId: string, ids: string[]) {
  return runInDurableObject(await hubOf(userId), (i: BusHub) => i.namesOf(ids));
}

describe("namesOf (#1889)", () => {
  it("returns only identityId and the current name, live or away", async () => {
    const s = await scene();
    const name = await reg(s.d, "r1", "Lead", s.ns);
    await bind(s.d, "r1", hashOf("a"));
    const id = (await identityOf(s.m.userId, s.ns, name))?.identityId as string;
    const got = await namesOf(s.m.userId, [id, "nope"]);
    expect(got).toEqual([{ identityId: id, name }]);
    expect(Object.keys(got[0] ?? {}).sort()).toEqual(["identityId", "name"]);
    await close(s.d, s.m.userId, "r1");
    expect(await namesOf(s.m.userId, [id])).toEqual([{ identityId: id, name }]);
  });
  it("never resolves another member's identity, and ignores junk input", async () => {
    const a = await scene();
    const name = await reg(a.d, "r1", "Lead", a.ns);
    await bind(a.d, "r1", hashOf("a"));
    const id = (await identityOf(a.m.userId, a.ns, name))?.identityId as string;
    const b = await member();
    expect(await namesOf(b.userId, [id])).toEqual([]);
    expect(await namesOf(a.m.userId, [])).toEqual([]);
    expect(await namesOf(a.m.userId, [42 as never, ""])).toEqual([]);
  });
});

// #2110: a session closed into away (sessions{closed}: the daemon's liveness
// close, a daemon restart) keeps its proofs for PROOF_AWAY_GRACE_MS, for its
// own row only; a close for good ends them at once. Time is the test clock.
describe("the away grace (#2110)", () => {
  const count = (userId: string) =>
    rows(userId, "select count(*) as n from agent_proofs");
  /** A bound agent closed into away at t0; the clock stays at t0. */
  async function away(caps: string[] = [BUS_CAPS.link]) {
    const s = await scene(caps);
    const t0 = Date.now() + 3_600_000 + ++seq * 1000;
    await setClock(s.m.userId, t0);
    const name = await reg(s.d, "r1", "Lead", s.ns);
    await bind(s.d, "r1", hashOf("e"));
    const live = await lookup(s.m.userId, hashOf("e"));
    expect(live).not.toBeNull();
    await close(s.d, s.m.userId, "r1");
    return { ...s, t0, name, live };
  }

  it("a daemon socket drop leaves the proof linked; a restart's close links within the grace, not after", async () => {
    const s = await scene();
    const t0 = Date.now() + 3_600_000 + ++seq * 1000;
    await setClock(s.m.userId, t0);
    await reg(s.d, "r1", "Lead", s.ns);
    await bind(s.d, "r1", hashOf("e"));
    const live = await lookup(s.m.userId, hashOf("e"));
    s.d.close();
    await s.d.closed;
    expect(await lookup(s.m.userId, hashOf("e"))).toEqual(live);
    // The restarted daemon reports the session closed (not yet re-read).
    const d2 = await connect(s.mach.token, [BUS_CAPS.link]);
    await close(d2, s.m.userId, "r1");
    await setClock(s.m.userId, t0 + PROOF_AWAY_GRACE_MS - 1);
    expect(await lookup(s.m.userId, hashOf("e"))).toEqual(live);
    await setClock(s.m.userId, t0 + PROOF_AWAY_GRACE_MS);
    expect(await lookup(s.m.userId, hashOf("e"))).toBeNull();
    await setClock(s.m.userId, null);
  });

  it("a re-register within the grace links, with its hash column back", async () => {
    const s = await away();
    await setClock(s.m.userId, s.t0 + PROOF_AWAY_GRACE_MS - 1);
    expect(await reg(s.d, "r1", "Lead", s.ns)).toBe(s.name);
    // Live again: no longer bound by the grace.
    await setClock(s.m.userId, s.t0 + 10 * PROOF_AWAY_GRACE_MS);
    expect(await lookup(s.m.userId, hashOf("e"))).toEqual(s.live);
    expect(
      await rows(
        s.m.userId,
        "select proof_hash as p from agents where native_ref = 'r1'",
      ),
    ).toEqual([{ p: hashOf("e") }]);
    await setClock(s.m.userId, null);
  });

  it("a reopen after the grace does not revive the proof, and the alarm sweeps it", async () => {
    const s = await away();
    await setClock(s.m.userId, s.t0 + PROOF_AWAY_GRACE_MS);
    await runInDurableObject(
      await hubOf(s.m.userId),
      async (_: BusHub, st: DurableObjectState) => {
        if ((await st.storage.getAlarm()) === null)
          await st.storage.setAlarm(s.t0 + PROOF_AWAY_GRACE_MS);
      },
    );
    await runDurableObjectAlarm(await hubOf(s.m.userId));
    expect(await count(s.m.userId)).toEqual([{ n: 0 }]);
    // The read alone also refuses it, swept or not: a later reopen of a row
    // whose proofs were left (no alarm yet) drops them first.
    const t = await away();
    await setClock(t.m.userId, t.t0 + PROOF_AWAY_GRACE_MS);
    await reg(t.d, "r1", "Lead", t.ns);
    expect(await lookup(t.m.userId, hashOf("e"))).toBeNull();
    expect(await count(t.m.userId)).toEqual([{ n: 0 }]);
    await setClock(s.m.userId, null);
    await setClock(t.m.userId, null);
  });

  it("agent_down (a session closed for good) never links, even within the grace", async () => {
    const s = await scene();
    await reg(s.d, "r1", "Lead", s.ns);
    await bind(s.d, "r1", hashOf("f"));
    s.d.send({ v: 1, id: id("dn"), type: "agent_down", agent_ref: "r1" });
    for (;;) {
      const r = await rows(
        s.m.userId,
        "select live, away_since as t from agents where native_ref = 'r1'",
      );
      if (r[0]?.live === 0) {
        // Closed into away like a sessions close: only the drop ends it.
        expect(typeof r[0]?.t).toBe("number");
        break;
      }
      await new Promise((res) => setTimeout(res, 5));
    }
    expect(await lookup(s.m.userId, hashOf("f"))).toBeNull();
    expect(await count(s.m.userId)).toEqual([{ n: 0 }]);
  });

  it("a sign-out (closeAll) ends an away session's link", async () => {
    const s = await away();
    expect(await lookup(s.m.userId, hashOf("e"))).toEqual(s.live);
    await (await hubOf(s.m.userId)).closeAll("signed out");
    expect(await lookup(s.m.userId, hashOf("e"))).toBeNull();
    expect(await count(s.m.userId)).toEqual([{ n: 0 }]);
    await setClock(s.m.userId, null);
  });

  it("an unlinked identity (its name taken back by a new session) ends the link", async () => {
    const s = await away();
    expect(await reg(s.d, "r2", s.name, s.ns)).toBe(s.name);
    expect(await lookup(s.m.userId, hashOf("e"))).toBeNull();
    // Even a proof row left on the unlinked row never resolves.
    await rows(
      s.m.userId,
      "insert into agent_proofs (hash, agent_id, seq) select ?, id, 99 from agents where native_ref = 'r1'",
      hashOf("e"),
    );
    expect(await lookup(s.m.userId, hashOf("e"))).toBeNull();
    await setClock(s.m.userId, null);
  });

  it("a revoked machine's away session never links", async () => {
    const s = await away();
    expect(await (await hubOf(s.m.userId)).revokeMachine(s.mach.id)).toBe(
      true,
    );
    expect(await lookup(s.m.userId, hashOf("e"))).toBeNull();
    expect(await count(s.m.userId)).toEqual([{ n: 0 }]);
    // Even a proof row left behind never resolves on a revoked machine.
    await rows(
      s.m.userId,
      "insert into agent_proofs (hash, agent_id, seq) select ?, id, 99 from agents where native_ref = 'r1'",
      hashOf("e"),
    );
    await rows(
      s.m.userId,
      "update agents set away_since = ? where native_ref = 'r1' returning id",
      s.t0,
    );
    expect(await lookup(s.m.userId, hashOf("e"))).toBeNull();
    await setClock(s.m.userId, null);
  });

  it("a proof resolves only to its own row: two agents, one away, and a swap", async () => {
    const s = await scene();
    const t0 = Date.now() + 3_600_000 + ++seq * 1000;
    await setClock(s.m.userId, t0);
    await reg(s.d, "r1", "Lead", s.ns);
    await reg(s.d, "r2", "Other", s.ns);
    await bind(s.d, "r1", hashOf("1"));
    await bind(s.d, "r2", hashOf("2"));
    const own = async () =>
      Object.fromEntries(
        (
          await rows(
            s.m.userId,
            "select p.hash as h, a.identity_id as i, a.name as n from agent_proofs p join agents a on a.id = p.agent_id",
          )
        ).map((r) => [r.h, { i: r.i, n: r.n }]),
      );
    const check = async () => {
      const o = await own();
      for (const h of [hashOf("1"), hashOf("2")]) {
        const got = await lookup(s.m.userId, h);
        expect(got?.identityId).toBe(o[h]?.i);
        expect(got?.name).toBe(o[h]?.n);
      }
    };
    await check();
    await close(s.d, s.m.userId, "r1");
    await check();
    const a = await lookup(s.m.userId, hashOf("1"));
    const b = await lookup(s.m.userId, hashOf("2"));
    expect(a?.identityId).not.toBe(b?.identityId);
    // r2 takes r1's proof: it moves to r2 and never resolves to away r1 again.
    await bind(s.d, "r2", hashOf("1"));
    expect((await lookup(s.m.userId, hashOf("1")))?.identityId).toBe(
      b?.identityId,
    );
    await check();
    // Another machine cannot bind a proof to the away r1.
    const other = await machine("Other", s.m.userId);
    const d2 = await connect(other.token, [BUS_CAPS.link]);
    expect(await bind(d2, "r1", hashOf("3"))).toMatchObject({
      type: "error",
      code: "not_registered",
    });
    expect(await lookup(s.m.userId, hashOf("3"))).toBeNull();
    await setClock(s.m.userId, null);
  });
});
