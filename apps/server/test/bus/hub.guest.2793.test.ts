// #2793 S3b: a Claude Code session homed on another instance joins this one as
// a GUEST only after it used this instance's tools. Hub side: proof_seen goes
// only on a tools/call, only to the credential owner's own daemons; a guest is
// a name and a kind with no address, on no roster and reached by no name; a
// proof it binds names it where it acted; only three structured notices reach
// it; a revoke drops it. Real hubs and daemon sockets; waits are frames.
import { runInDurableObject } from "cloudflare:test";
import {
  BUS_CAPS,
  type ClientFrame,
  LINK_PROOF_HEADER,
} from "@oa/bus-protocol";
import { type BusNotice, NOTICE_SENDER, newId } from "@oa/shared";
import { describe, expect, it } from "vitest";
import type { BusHub } from "../../src/bus/hub.js";
import { linkRequest } from "../../src/services/bus.js";
import { sha256Hex } from "../../src/util/crypto.js";
import { MCP_URL } from "../mcp-helpers.js";
import {
  type Daemon,
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

let seq = 0;
const id = (t: string) => `${t}${++seq}`;
const proofOf = () =>
  `${"g".repeat(11)}${crypto.randomUUID().replaceAll("-", "")}`;

const CAPS = [BUS_CAPS.link, BUS_CAPS.guest, BUS_CAPS.noticeMeta, BUS_CAPS.ids];

async function scene(caps: string[] = CAPS) {
  const m = await member();
  const mach = await machine("Laptop", m.userId);
  const d = await daemon(mach.token);
  d.send({ ...hello(id("h")), caps } as ClientFrame);
  await waitFor(d, "hello_ok");
  return { m, mach, d };
}

const rows = async (userId: string, q: string, ...b: SqlStorageValue[]) =>
  runInDurableObject(
    await hubOf(userId),
    (_: BusHub, s: DurableObjectState) =>
      s.storage.sql.exec(q, ...b).toArray() as Record<string, unknown>[],
  );

const call = (method: string, proof: string) =>
  new Request(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer x",
      [LINK_PROOF_HEADER]: proof,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
  });

const seen = (d: Daemon) =>
  framesSeen(d).filter((f) => f.type === "proof_seen") as {
    type: "proof_seen";
    hash: string;
  }[];

async function guestUp(d: Daemon, ref: string, name: string) {
  d.send({
    v: 1,
    id: id("g"),
    type: "guest_up",
    agent_ref: ref,
    kind: "claude-code",
    proposed_name: name,
  } as ClientFrame);
  return (await waitFor(d, "agent_ok")).bus_name;
}

async function bindGuest(d: Daemon, ref: string, proof: string) {
  d.send({
    v: 1,
    id: id("b"),
    type: "link_bind",
    agent_ref: ref,
    hash: await sha256Hex(proof),
  } as never);
  await waitFor(d, "link_bound");
}

/** A round trip on the socket: everything sent to it before has arrived. */
async function settle(d: Daemon) {
  d.send({ ...hello(id("h")), caps: CAPS } as ClientFrame);
  await waitFor(d, "hello_ok");
}

describe("proof_seen (#2793 S3b)", () => {
  it("is sent for a tools/call whose proof no session holds, to the owner's daemon, carrying the hash only", async () => {
    const { m, d } = await scene();
    const proof = proofOf();
    const r = await linkRequest(
      e as never,
      m.userId,
      call("tools/call", proof),
    );
    expect(r.identity).toBeUndefined();
    const f = await waitFor(d, "proof_seen");
    expect(f).toMatchObject({ hash: await sha256Hex(proof) });
    expect(Object.keys(f).sort()).toEqual(["hash", "id", "type", "v"]);
    expect(d.raw.join("\n")).not.toContain(proof);
  });

  it("is never sent for initialize, tools/list or any other method", async () => {
    const { m, d } = await scene();
    for (const method of [
      "initialize",
      "tools/list",
      "ping",
      "notifications/initialized",
    ])
      await linkRequest(e as never, m.userId, call(method, proofOf()));
    const real = proofOf();
    await linkRequest(e as never, m.userId, call("tools/call", real));
    await waitFor(d, "proof_seen");
    // The one frame is the tools/call's.
    expect(seen(d)).toEqual([
      expect.objectContaining({ hash: await sha256Hex(real) }),
    ]);
  });

  it("goes only to the credential owner's daemons: another member's call never reaches this person's daemon", async () => {
    const a = await scene();
    const b = await scene();
    const proof = proofOf();
    await linkRequest(e as never, b.m.userId, call("tools/call", proof));
    await waitFor(b.d, "proof_seen");
    await settle(a.d);
    expect(seen(a.d)).toEqual([]);
    // And the reverse: A's call reaches A's daemon, not B's.
    await linkRequest(e as never, a.m.userId, call("tools/call", proofOf()));
    await waitFor(a.d, "proof_seen");
    await settle(b.d);
    expect(seen(b.d)).toHaveLength(1);
  });

  it("goes only to a socket whose hello listed the guest cap", async () => {
    const { m, d } = await scene([BUS_CAPS.link]);
    await linkRequest(e as never, m.userId, call("tools/call", proofOf()));
    await settle(d);
    expect(seen(d)).toEqual([]);
  });

  it("is not sent for a proof a session holds", async () => {
    const { m, d } = await scene();
    const proof = proofOf();
    await guestUp(d, "s1", "Visitor");
    await bindGuest(d, "s1", proof);
    const r = await linkRequest(
      e as never,
      m.userId,
      call("tools/call", proof),
    );
    expect(r.identity?.name).toBe("Visitor");
    await settle(d);
    expect(seen(d)).toEqual([]);
  });
});

describe("a guest on the hub (#2793 S3b)", () => {
  it("is a name and a kind: no address, namespace, folder, global flag or role, and no agents row", async () => {
    const { m, d } = await scene();
    const name = await guestUp(d, "s1", "Visitor");
    expect(name).toBe("Visitor");
    const g = await rows(m.userId, "select * from guests");
    expect(g).toHaveLength(1);
    expect(Object.keys(g[0] ?? {}).sort()).toEqual([
      "id",
      "identity_id",
      "kind",
      "machine_id",
      "name",
      "native_ref",
      "updated_at",
    ]);
    expect(g[0]).toMatchObject({ name: "Visitor", kind: "claude-code" });
    expect(await rows(m.userId, "select id from agents")).toEqual([]);
  });

  it("is absent from list_agents for other agents and no name reaches it", async () => {
    const { m, d } = await scene();
    const space = ns("guest");
    d.send(up(id("u"), "lead", "Lead", space));
    await waitFor(d, "agent_ok");
    await guestUp(d, "s1", "Visitor");
    await bindGuest(d, "s1", proofOf());
    d.send({ v: 1, id: id("l"), type: "list", from_ref: "lead" } as never);
    const roster = await waitFor(d, "roster");
    expect(roster.agents.map((a) => a.bus_name)).toEqual(["Lead"]);
    expect(JSON.stringify(roster)).not.toContain("Visitor");
    d.send({
      v: 1,
      id: id("s"),
      type: "send",
      from_ref: "lead",
      to_name: "Visitor",
      body: "hi",
    } as never);
    const r = await waitFor(d, "receipt");
    expect(r.state).toBe("refused");
    expect(await rows(m.userId, "select count(*) as n from mail")).toEqual([
      { n: 0 },
    ]);
  });

  it("a proof it binds names it where it acted, with a fixed namespace", async () => {
    const { m, d } = await scene();
    const proof = proofOf();
    await guestUp(d, "s1", "Visitor");
    await bindGuest(d, "s1", proof);
    const r = await linkRequest(
      e as never,
      m.userId,
      call("tools/list", proof),
    );
    expect(r.identity).toMatchObject({
      name: "Visitor",
      kind: "claude-code",
      namespace: "guest",
    });
  });

  it("guest_up, guest_down and a guest's link_bind are as unknown as to an old hub without the cap", async () => {
    const { d } = await scene([BUS_CAPS.link]);
    d.send({
      v: 1,
      id: "gx1",
      type: "guest_up",
      agent_ref: "s1",
      kind: "claude-code",
      proposed_name: "V",
    } as ClientFrame);
    const err = await waitFor(d, "error");
    expect(err).toMatchObject({ id: "gx1", code: "bad_frame" });
  });

  it("guest_down removes it and its proofs", async () => {
    const { m, d } = await scene();
    const proof = proofOf();
    await guestUp(d, "s1", "Visitor");
    await bindGuest(d, "s1", proof);
    d.send({ v: 1, id: id("d"), type: "guest_down", agent_ref: "s1" } as never);
    await settle(d);
    expect(await rows(m.userId, "select id from guests")).toEqual([]);
    expect(await rows(m.userId, "select hash from agent_proofs")).toEqual([]);
  });

  it("a revoke of the machine drops its guests and their proofs", async () => {
    const { m, mach, d } = await scene();
    const proof = proofOf();
    await guestUp(d, "s1", "Visitor");
    await bindGuest(d, "s1", proof);
    await runInDurableObject(await hubOf(m.userId), (i: BusHub) =>
      i.revokeMachine(mach.id),
    );
    expect(await rows(m.userId, "select id from guests")).toEqual([]);
    const r = await linkRequest(
      e as never,
      m.userId,
      call("tools/list", proof),
    );
    expect(r.identity).toBeUndefined();
  });
});

describe("what reaches a guest (#2793 S3b)", () => {
  const note = (over: Partial<BusNotice>, identity: string): BusNotice => {
    const artifactId = `art${++seq}`;
    return {
      id: newId(),
      kind: "comment",
      from: NOTICE_SENDER,
      artifactId,
      version: 1,
      url: `https://app.test/a/${artifactId}`,
      to: { namespace: "guest", name: "Visitor" },
      toIdentity: identity,
      text: "fixed words",
      coalesceKey: `${artifactId}:${seq}`,
      threadId: "t1",
      commentId: "c1",
      ...over,
    };
  };
  async function guestScene(caps: string[] = CAPS) {
    const s = await scene(caps);
    const proof = proofOf();
    await guestUp(s.d, "s1", "Visitor");
    await bindGuest(s.d, "s1", proof);
    const identity = (
      await rows(s.m.userId, "select identity_id from guests")
    )[0]?.identity_id as string;
    const deliver = async (n: BusNotice) =>
      runInDurableObject(await hubOf(s.m.userId), (i: BusHub) =>
        i.deliverNotice(n),
      );
    return { ...s, identity, deliver };
  }
  const delivers = (d: Daemon) =>
    framesSeen(d).filter((f) => f.type === "deliver");

  it.each([
    ["ask_answered", {}, "answer"],
    ["comment", { target: { kind: "mention", key: "k" } }, "mention"],
    ["comment", { target: { kind: "asker", key: "k" } }, "reply"],
    ["comment", { target: { kind: "reply", key: "k" } }, "reply"],
  ] as const)(
    "a %s notice (%j) is delivered with meta.guest %s",
    async (kind, extra, guest) => {
      const s = await guestScene();
      const out = await s.deliver(note({ kind, ...extra }, s.identity));
      expect(["delivered", "held"]).toContain(out);
      const f = delivers(s.d).at(-1) as never as {
        to_ref: string;
        from_name: string;
        meta: { guest: string };
      };
      expect(f).toMatchObject({
        to_ref: "s1",
        from_name: NOTICE_SENDER,
        meta: { guest },
      });
    },
  );

  it.each([
    ["shared", {}],
    ["changed", {}],
    ["commented", {}],
    ["ask_later", {}],
    ["comment", {}],
  ] as const)(
    "a %s notice with no guest kind is dropped, nothing sent",
    async (kind, extra) => {
      const s = await guestScene();
      const out = await s.deliver(note({ kind, ...extra }, s.identity));
      expect(out).toBe("dropped");
      await settle(s.d);
      expect(delivers(s.d)).toEqual([]);
    },
  );

  it("is dropped, never held, when the socket did not list notice_meta", async () => {
    const s = await guestScene([BUS_CAPS.link, BUS_CAPS.guest]);
    const out = await s.deliver(note({ kind: "ask_answered" }, s.identity));
    expect(out).toBe("dropped");
    await settle(s.d);
    expect(delivers(s.d)).toEqual([]);
  });
});
