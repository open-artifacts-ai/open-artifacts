// #1822: link_bind (BUS_CAPS.link) and the hub's proof lookup. A real hub and
// real daemon sockets. A bind is accepted only for an agent the socket
// registered; a new bind replaces the old hash; a close clears it; the
// identity_id survives a rename and moves with a reclaimed name on the same
// machine only. Waits are signals (the reply frame), never sleeps; time is
// BusHub.setTestClock, reset after each test.
import { runInDurableObject } from "cloudflare:test";
import { BUS_CAPS, type ClientFrame } from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import { BusHub } from "../../src/bus/hub.js";
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

  it("a new bind replaces the old hash and keeps the identity", async () => {
    const s = await scene();
    await reg(s.d, "r1", "Lead", s.ns);
    await bind(s.d, "r1", hashOf("1"));
    const first = await lookup(s.m.userId, hashOf("1"));
    await bind(s.d, "r1", hashOf("2"));
    expect(await lookup(s.m.userId, hashOf("1"))).toBeNull();
    expect((await lookup(s.m.userId, hashOf("2")))?.identityId).toBe(
      first?.identityId,
    );
  });

  it("closing the session clears the hash", async () => {
    const s = await scene();
    await reg(s.d, "r1", "Lead", s.ns);
    await bind(s.d, "r1", hashOf("3"));
    expect(await lookup(s.m.userId, hashOf("3"))).not.toBeNull();
    await close(s.d, s.m.userId, "r1");
    expect(await lookup(s.m.userId, hashOf("3"))).toBeNull();
    expect(
      await rows(
        s.m.userId,
        "select proof_hash from agents where native_ref = 'r1'",
      ),
    ).toEqual([{ proof_hash: null }]);
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
