// Ported from OpenBus v0.63.0 apps/server/test/hub.namespace.matrix.test.ts (#1291).
// Dropped: the RPC surface list now names the port's methods (closeAll,
// revokeMachine, snapshot); OpenBus's machine, device, role, link and session RPCs are gone.
// B8: fetch by id, the namespace / global matrix and the no-leak rules.
// Every frame a daemon receives is checked with decodeServerFrame (helpers.ts).
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  type ClientFrame,
  decodeServerFrame,
  LIMITS,
  newId,
  PONG,
  type ServerFrame,
} from "@oa/bus-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BusHub } from "../../src/bus/hub.js";
import {
  type Daemon,
  framesSeen,
  hello,
  hubOf,
  inOwnerHub,
  machine,
  ns,
  ready,
  up,
  waitFor,
} from "./helpers.js";

const stub = () => hubOf();
const inHub = async <R>(fn: (i: BusHub, s: DurableObjectState) => R) =>
  runInDurableObject(await stub(), fn);
const setClock = (ms: number | null) =>
  inHub((i) => BusHub.setTestClock(i, ms));
const runAlarm = async () => runDurableObjectAlarm(await stub());

afterEach(async () => {
  await setClock(null);
});

type Receipt = Extract<ServerFrame, { type: "receipt" }>;
type ErrorF = Extract<ServerFrame, { type: "error" }>;

let seq = 0;
/** A bus name no other test uses (global names are unique across namespaces). */
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;
/** Above inlineBodyBytes: delivered as a notice, body kept for fetch. */
const BIG = "n".repeat(LIMITS.inlineBodyBytes + 1);

const send = (
  id: string,
  from_ref: string,
  to_name: string,
  body = "hello",
  to_namespace?: string,
): ClientFrame =>
  to_namespace === undefined
    ? { v: 1, id, type: "send", from_ref, to_name, body }
    : { v: 1, id, type: "send", from_ref, to_name, to_namespace, body };
const fetchF = (id: string, from_ref: string, msg_id: string): ClientFrame => ({
  v: 1,
  id,
  type: "fetch",
  from_ref,
  msg_id,
});
const ack = (id: string, msg_id: string): ClientFrame => ({
  v: 1,
  id,
  type: "ack",
  msg_id,
});
const list = (id: string, from_ref: string): ClientFrame => ({
  v: 1,
  id,
  type: "list",
  from_ref,
});

async function agent(
  d: Daemon,
  ref: string,
  name: string,
  namespace: string,
  global = false,
): Promise<void> {
  d.send(up(`u-${ref}-${++seq}`, ref, name, namespace, global));
  expect((await waitFor(d, "agent_ok")).bus_name).toBe(name);
}

/** Frames on one socket are handled in order: once hello_ok is back, all earlier frames were. */
async function barrier(d: Daemon): Promise<void> {
  const id = `b${++seq}`;
  d.send(hello(id));
  for (;;) if ((await waitFor(d, "hello_ok")).id === id) return;
}

async function reply<T extends ServerFrame["type"]>(
  d: Daemon,
  f: ClientFrame,
  type: T,
): Promise<Extract<ServerFrame, { type: T }>> {
  d.send(f);
  for (;;) {
    const r = await waitFor(d, type);
    if (r.id === f.id) return r;
  }
}

/** The fetch reply, whichever type it is. */
async function fetchReply(d: Daemon, f: ClientFrame): Promise<ServerFrame> {
  d.send(f);
  for (;;) {
    const r = await d.next();
    if (r.id === f.id) return r;
  }
}

const sendAndReceipt = (d: Daemon, f: ClientFrame): Promise<Receipt> =>
  reply(d, f, "receipt");

const receiptRow = (id: string) =>
  inOwnerHub(
    (s) =>
      s.storage.sql
        .exec<{
          state: string;
          notifiedAt: number | null;
          finalAt: number | null;
        }>(
          "select state, notified_at as notifiedAt, final_at as finalAt from receipts where id = ?",
          id,
        )
        .toArray()[0] ?? null,
  );
const mailRow = (id: string) =>
  inOwnerHub(
    (s) =>
      s.storage.sql
        .exec<{ body: string }>("select body from mail where id = ?", id)
        .toArray()[0] ?? null,
  );

/** receipt_updates seen on `d` for `msgId`. */
const updatesFor = (d: Daemon, msgId: string) =>
  framesSeen(d).filter(
    (f) => f.type === "receipt_update" && f.msg_id === msgId,
  );

/** An error frame with its id dropped, as a canonical string. */
const sansId = (f: ServerFrame) => {
  const { id: _id, ...rest } = f;
  return JSON.stringify(rest);
};

/** Every raw frame the daemon got parses as a server frame. */
const allParse = (...ds: Daemon[]) => {
  for (const d of ds)
    for (const t of d.raw.filter((x) => x !== PONG))
      expect(decodeServerFrame(t).ok, t).toBe(true);
};

/** Two machines: S hosts the senders, T the recipients. */
async function pair() {
  const sm = await machine("Sender");
  const tm = await machine("Target");
  const s = await ready(sm.token);
  const t = await ready(tm.token);
  const close = () => {
    for (const d of [s, t])
      try {
        d.close();
      } catch {
        // Already closed.
      }
  };
  return { s, t, close };
}

describe("namespaces and globals", () => {
  it("keeps namespaces invisible to each other", async () => {
    const m = await machine("A");
    const a = await ready(m.token);
    const n1 = ns();
    const n2 = ns();
    const alpha = uniq("Alpha");
    const beta = uniq("Beta");
    await agent(a, "refA", alpha, n1);
    await agent(a, "refB", beta, n2);

    const roster = await reply(a, list("l1", "refA"), "roster");
    const names = roster.agents.map((x) => x.bus_name);
    expect(names).toContain(alpha);
    expect(names).not.toContain(beta);
    expect(roster.agents.every((x) => x.namespace === n1 || x.global)).toBe(
      true,
    );

    // Another namespace is invisible: a name live only there is unknown.
    expect(await sendAndReceipt(a, send("s1", "refA", beta))).toMatchObject({
      state: "refused",
      reason: "unknown_agent",
    });
    allParse(a);
    a.close();
  });

  it("lets a global agent see and reach every namespace, and be reached", async () => {
    const m = await machine("A");
    const a = await ready(m.token);
    const n1 = ns();
    const n2 = ns();
    const alpha = uniq("Alpha");
    const glob = uniq("Glob");
    await agent(a, "refA", alpha, n1);
    await agent(a, "refG", glob, n2, true);

    const g = (await reply(a, list("l1", "refG"), "roster")).agents.map(
      (x) => x.bus_name,
    );
    expect(g).toEqual(expect.arrayContaining([alpha, glob]));

    // Names are case-insensitive.
    expect(
      (await sendAndReceipt(a, send("s1", "refG", alpha.toUpperCase()))).state,
    ).toBe("pending");
    // Any agent can reach a global one.
    expect(
      (await sendAndReceipt(a, send("s2", "refA", glob.toLowerCase()))).state,
    ).toBe("pending");

    const r = (await reply(a, list("l2", "refA"), "roster")).agents;
    expect(r.map((x) => x.bus_name)).toEqual(
      expect.arrayContaining([alpha, glob]),
    );
    expect(r.find((x) => x.bus_name === glob)?.global).toBe(true);
    allParse(a);
    a.close();
  });

  it("to_namespace from a non-global sender leaks nothing", async () => {
    const m = await machine("A");
    const a = await ready(m.token);
    const own = ns();
    const x = ns();
    const sender = uniq("S");
    const glob = uniq("G");
    const local = uniq("L");
    await agent(a, "s", sender, own);
    await agent(a, "g", glob, x, true);
    await agent(a, "l", local, x);

    expect(
      (await sendAndReceipt(a, send("t1", "s", glob, "hi", x))).state,
    ).toBe("pending");
    const r1 = await sendAndReceipt(a, send("t2", "s", local, "hi", x));
    const r2 = await sendAndReceipt(
      a,
      send("t3", "s", uniq("Nobody"), "hi", x),
    );
    expect(r1).toMatchObject({ state: "refused", reason: "other_namespace" });
    const strip = (f: Receipt) => {
      const { id: _i, msg_id: _m, ...rest } = f;
      return JSON.stringify(rest);
    };
    expect(strip(r1)).toBe(strip(r2));
    allParse(a);
    a.close();
  });

  it("rule 1: without to_namespace, a name outside the sender's view is unknown_agent whether or not it lives elsewhere", async () => {
    const m = await machine("A");
    const a = await ready(m.token);
    const own = ns();
    const elsewhere = ns();
    const live = uniq("Elsewhere");
    await agent(a, "s", uniq("S"), own);
    await agent(a, "e", live, elsewhere);
    const r1 = await sendAndReceipt(a, send("t1", "s", live));
    const r2 = await sendAndReceipt(a, send("t2", "s", uniq("Nobody")));
    expect(r1).toMatchObject({ state: "refused", reason: "unknown_agent" });
    const strip = (f: Receipt) => {
      const { id: _i, msg_id: _m, ...rest } = f;
      return JSON.stringify(rest);
    };
    expect(strip(r1)).toBe(strip(r2));
    // closed in its own namespace still says closed.
    const gone = uniq("Gone");
    await agent(a, "c", gone, own);
    a.send({ v: 1, id: "d1", type: "agent_down", agent_ref: "c" });
    await barrier(a);
    expect(await sendAndReceipt(a, send("t3", "s", gone))).toMatchObject({
      state: "refused",
      reason: "closed",
    });
    allParse(a);
    a.close();
  });

  it("rule 2: other_namespace only answers an explicit to_namespace, whether or not the name is there", async () => {
    const m = await machine("A");
    const a = await ready(m.token);
    const own = ns();
    const x = ns();
    const there = uniq("There");
    await agent(a, "s", uniq("S"), own);
    await agent(a, "x", there, x);
    for (const [id, name] of [
      ["t1", there],
      ["t2", uniq("Absent")],
    ] as const)
      expect(
        await sendAndReceipt(a, send(id, "s", name, "hi", x)),
      ).toMatchObject({ state: "refused", reason: "other_namespace" });
    allParse(a);
    a.close();
  });

  it("a global sender reaches X with to_namespace, and is told ambiguous without", async () => {
    const m = await machine("A");
    const a = await ready(m.token);
    const x = ns();
    const y = ns();
    const glob = uniq("G");
    const dup = uniq("Dup");
    await agent(a, "g", glob, ns(), true);
    await agent(a, "dx", dup, x);
    await agent(a, "dy", dup, y);

    expect((await sendAndReceipt(a, send("t1", "g", dup, "hi", x))).state).toBe(
      "pending",
    );
    expect(await sendAndReceipt(a, send("t2", "g", dup))).toMatchObject({
      state: "refused",
      reason: "ambiguous",
    });
    allParse(a);
    a.close();
  });
});

describe("fetch", () => {
  it("serves the recipient once and refuses everyone else identically", async () => {
    const { s, t, close } = await pair();
    const n = ns();
    const sender = uniq("Sender");
    const receiver = uniq("Receiver");
    await agent(s, "a", sender, n);
    await agent(t, "b", receiver, n);
    // Same ref string as the recipient, but on the sender's machine.
    await agent(s, "b", uniq("Imposter"), n);

    const receipt = await sendAndReceipt(s, send("s1", "a", receiver, BIG));
    expect(receipt.state).toBe("pending");
    const deliver = await waitFor(t, "deliver");
    expect(deliver.notice).toEqual({
      size: BIG.length,
      msg_id: receipt.msg_id,
    });
    const id = receipt.msg_id;

    const errors: ServerFrame[] = [];
    // The sender may not read the recipient's mail.
    errors.push(await fetchReply(s, fetchF("f1", "a", id)));
    // Same ref string on another machine: a different agent.
    errors.push(await fetchReply(s, fetchF("f2", "b", id)));
    // An unknown id.
    errors.push(await fetchReply(t, fetchF("f3", "b", newId())));
    // A ref not registered on this socket.
    const nr = (await fetchReply(t, fetchF("f4", "zz", id))) as ErrorF;
    expect(nr).toMatchObject({ type: "error", code: "not_registered" });

    for (const f of errors)
      expect(f).toMatchObject({ type: "error", code: "not_found" });
    expect(await receiptRow(id)).toMatchObject({ state: "pending" });

    // The recipient may; the fetch closes the receipt.
    const body = await fetchReply(t, fetchF("f5", "b", id));
    expect(body).toEqual({
      v: 1,
      id: "f5",
      type: "body",
      msg_id: id,
      body: BIG,
    });
    expect(await mailRow(id)).toBeNull();
    const row = await receiptRow(id);
    expect(row).toMatchObject({ state: "delivered" });
    expect(row?.finalAt).not.toBeNull();
    expect(row?.notifiedAt).not.toBeNull();
    await barrier(s);
    expect(updatesFor(s, id)).toEqual([
      expect.objectContaining({ state: "delivered" }),
    ]);

    // Once fetched, nothing is left.
    errors.push(await fetchReply(t, fetchF("f6", "b", id)));
    // A late ack and an alarm run tell the sender nothing more.
    t.send(ack("k1", id));
    await barrier(t);
    await runAlarm();
    await barrier(s);
    expect(updatesFor(s, id)).toHaveLength(1);

    const shapes = new Set(errors.map(sansId));
    expect(
      errors.every((f) => f.type === "error" && f.code === "not_found"),
    ).toBe(true);
    expect(shapes.size).toBe(1);
    allParse(s, t);
    close();
  });

  it("serves an acked notice once, without telling the sender again", async () => {
    const { s, t, close } = await pair();
    const n = ns();
    const receiver = uniq("R");
    await agent(s, "a", uniq("S"), n);
    await agent(t, "b", receiver, n);
    const { msg_id: id } = await sendAndReceipt(
      s,
      send("s1", "a", receiver, BIG),
    );
    await waitFor(t, "deliver");
    t.send(ack("k1", id));
    await barrier(t);
    await barrier(s);
    expect(updatesFor(s, id)).toHaveLength(1);
    expect(await mailRow(id)).not.toBeNull();

    expect(await fetchReply(t, fetchF("f1", "b", id))).toMatchObject({
      type: "body",
      body: BIG,
    });
    expect(await mailRow(id)).toBeNull();
    expect(await fetchReply(t, fetchF("f2", "b", id))).toMatchObject({
      type: "error",
      code: "not_found",
    });
    await barrier(s);
    expect(updatesFor(s, id)).toHaveLength(1);
    allParse(s, t);
    close();
  });

  it("refuses inline, expired, refused and bodiless mail with the same not_found", async () => {
    const { s, t, close } = await pair();
    const n = ns();
    const receiver = uniq("R");
    await agent(s, "a", uniq("S"), n);
    await agent(t, "b", receiver, n);
    const errors: ServerFrame[] = [];

    // Inline and held (no mail row): not fetchable, still pending.
    const inl = (await sendAndReceipt(s, send("s1", "a", receiver, "tiny")))
      .msg_id;
    await waitFor(t, "deliver");
    errors.push(await fetchReply(t, fetchF("f1", "b", inl)));
    expect(await receiptRow(inl)).toMatchObject({ state: "pending" });
    t.send(ack("k1", inl));

    // Refused.
    const ref = (await sendAndReceipt(s, send("s2", "a", receiver, BIG)))
      .msg_id;
    await waitFor(t, "deliver");
    t.send({
      v: 1,
      id: "r1",
      type: "refuse",
      msg_id: ref,
      reason: "closed",
      detail: "denied",
    });
    await barrier(t);
    errors.push(await fetchReply(t, fetchF("f2", "b", ref)));

    // A pending notice whose body is gone: not_found, left for the alarm.
    const lost = (await sendAndReceipt(s, send("s3", "a", receiver, BIG)))
      .msg_id;
    await waitFor(t, "deliver");
    await inOwnerHub((st) =>
      st.storage.sql.exec("delete from mail where id = ?", lost),
    );
    errors.push(await fetchReply(t, fetchF("f3", "b", lost)));
    expect(await receiptRow(lost)).toMatchObject({ state: "pending" });

    // Expired by the alarm.
    const exp = (await sendAndReceipt(s, send("s4", "a", receiver, BIG)))
      .msg_id;
    await waitFor(t, "deliver");
    await setClock(Date.now() + LIMITS.mailTtlSec * 1000 + 1000);
    await runAlarm();
    expect(await receiptRow(exp)).toMatchObject({ state: "expired" });
    errors.push(await fetchReply(t, fetchF("f4", "b", exp)));

    for (const f of errors)
      expect(f).toMatchObject({ type: "error", code: "not_found" });
    expect(new Set(errors.map(sansId)).size).toBe(1);
    allParse(s, t);
    close();
  });
});

/** The not_found frame every fetch miss must equal, apart from `id`. */
const NOT_FOUND = {
  v: 1,
  type: "error",
  code: "not_found",
  message: "No such message",
};
const expectNotFound = (f: ServerFrame) => {
  const { id: _id, ...rest } = f;
  expect(rest).toEqual(NOT_FOUND);
};

describe("fetch: closed sessions and TTL (adv-B8)", () => {
  for (const where of ["another", "the same"] as const)
    it(`a session reopened under the same ref in ${where} namespace cannot fetch the old session's acked notice (P1)`, async () => {
      const { s, t, close } = await pair();
      const n = ns();
      const receiver = uniq("R");
      await agent(s, "a", uniq("S"), n);
      await agent(t, "b", receiver, n);
      const { msg_id: id } = await sendAndReceipt(
        s,
        send("s1", "a", receiver, BIG),
      );
      await waitFor(t, "deliver");
      t.send(ack("k1", id));
      await barrier(t);
      t.send({ v: 1, id: "d1", type: "agent_down", agent_ref: "b" });
      await barrier(t);
      expect(await mailRow(id)).toBeNull();
      // The receipt itself is left alone.
      expect(await receiptRow(id)).toMatchObject({ state: "delivered" });
      await agent(t, "b", uniq("Again"), where === "another" ? ns() : n);
      expectNotFound(await fetchReply(t, fetchF("f1", "b", id)));
      allParse(s, t);
      close();
    });

  it("sessions{closed} also drops the closed agent's acked-notice bodies (P1)", async () => {
    const { s, t, close } = await pair();
    const n = ns();
    const receiver = uniq("R");
    await agent(s, "a", uniq("S"), n);
    await agent(t, "b", receiver, n);
    const { msg_id: id } = await sendAndReceipt(
      s,
      send("s1", "a", receiver, BIG),
    );
    await waitFor(t, "deliver");
    t.send(ack("k1", id));
    await barrier(t);
    t.send({ v: 1, id: "c1", type: "sessions", open: [], closed: ["b"] });
    await barrier(t);
    expect(await mailRow(id)).toBeNull();
    await agent(t, "b", uniq("Again"), n);
    expectNotFound(await fetchReply(t, fetchF("f1", "b", id)));
    allParse(s, t);
    close();
  });

  it("does not serve a pending notice past its TTL before the alarm runs (P2a)", async () => {
    const { s, t, close } = await pair();
    const n = ns();
    const receiver = uniq("R");
    await agent(s, "a", uniq("S"), n);
    await agent(t, "b", receiver, n);
    const { msg_id: id } = await sendAndReceipt(
      s,
      send("s1", "a", receiver, BIG),
    );
    await waitFor(t, "deliver");
    await setClock(Date.now() + LIMITS.mailTtlSec * 1000 + 5000);
    expectNotFound(await fetchReply(t, fetchF("f1", "b", id)));
    // Left for the alarm: still pending, body still stored, sender not told.
    expect(await receiptRow(id)).toMatchObject({ state: "pending" });
    expect(await mailRow(id)).not.toBeNull();
    await barrier(s);
    expect(updatesFor(s, id)).toHaveLength(0);
    await runAlarm();
    expect(await receiptRow(id)).toMatchObject({ state: "expired" });
    allParse(s, t);
    close();
  });

  it("does not serve an acked notice whose body is past expires_at before the sweep (P2b)", async () => {
    const { s, t, close } = await pair();
    const n = ns();
    const receiver = uniq("R");
    await agent(s, "a", uniq("S"), n);
    await agent(t, "b", receiver, n);
    const { msg_id: id } = await sendAndReceipt(
      s,
      send("s1", "a", receiver, BIG),
    );
    await waitFor(t, "deliver");
    t.send(ack("k1", id));
    await barrier(t);
    await setClock(Date.now() + LIMITS.mailTtlSec * 1000 + 5000);
    expectNotFound(await fetchReply(t, fetchF("f1", "b", id)));
    await runAlarm();
    expect(await mailRow(id)).toBeNull();
    allParse(s, t);
    close();
  });
});

describe("RPC surface", () => {
  it("is unchanged by fetch", () => {
    const own = Object.getOwnPropertyNames(BusHub.prototype)
      .filter(
        (n) =>
          ![
            "constructor",
            "alarm",
            "fetch",
            "webSocketClose",
            "webSocketError",
            "webSocketMessage",
          ].includes(n),
      )
      .sort();
    // The port's RPC surface (#1291): the Worker-only methods.
    expect(own).toEqual(["closeAll", "revokeMachine", "snapshot", "wipe"]);
  });
});
