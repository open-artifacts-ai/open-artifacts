// Ported from OpenBus v0.63.0 apps/server/test/hub.idempotent-send.test.ts (#1291).
// Dropped: nothing.
// B14: idempotent `send`. The hub dedupes on (sender agent id, send frame id)
// for SEND_KEY_RETAIN_MS (at least LIMITS.mailTtlSec). A resend returns the
// original receipt (msg_id and current state) and never delivers twice; the
// same id with another payload is `bad_frame` "frame id reused". Keys are
// capped per agent (SEND_KEYS_PER_AGENT) and swept by the alarm. Every frame a
// daemon receives is checked with decodeServerFrame (helpers.ts, allParse).
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  type ClientFrame,
  decodeServerFrame,
  LIMITS,
  type ServerFrame,
} from "@oa/bus-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  BusHub,
  SEND_KEY_RETAIN_MS,
  SEND_KEYS_PER_AGENT,
} from "../../src/bus/hub.js";
import {
  type Daemon,
  daemon,
  e,
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

let clock: number | null = null;
const setClock = (ms: number | null) => {
  clock = ms;
  return inHub((i) => BusHub.setTestClock(i, ms));
};
const alarmAt = () => inHub((_, s) => s.storage.getAlarm());
const runAlarm = async () => {
  await runDurableObjectAlarm(await stub());
  for (
    let i = 0;
    i < 200 && clock !== null && (await alarmAt()) === clock + 1;
    i++
  )
    await runDurableObjectAlarm(await stub());
};

afterEach(async () => {
  await setClock(null);
});

const TTL = LIMITS.mailTtlSec * 1000;

type Receipt = Extract<ServerFrame, { type: "receipt" }>;
type Update = Extract<ServerFrame, { type: "receipt_update" }>;
type ErrorF = Extract<ServerFrame, { type: "error" }>;

let seq = 0;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;

const send = (
  id: string,
  from_ref: string,
  to_name: string,
  body = "hello",
  to_namespace?: string,
): ClientFrame =>
  (to_namespace === undefined
    ? { v: 1, id, type: "send", from_ref, to_name, body }
    : {
        v: 1,
        id,
        type: "send",
        from_ref,
        to_name,
        to_namespace,
        body,
      }) as ClientFrame;
const ack = (id: string, msg_id: string): ClientFrame => ({
  v: 1,
  id,
  type: "ack",
  msg_id,
});

async function agent(d: Daemon, ref: string, name: string, n: string) {
  d.send(up(`u-${ref}-${++seq}`, ref, name, n));
  expect((await waitFor(d, "agent_ok")).bus_name).toBe(name);
}

/** Every frame the hub sent `d` before this returns has been received. */
async function barrier(d: Daemon): Promise<void> {
  const id = `b${++seq}`;
  d.send(hello(id));
  for (;;) if ((await waitFor(d, "hello_ok")).id === id) return;
}

/** Sends `f` and returns the reply that echoes its id (receipt or error). */
async function reply(d: Daemon, f: ClientFrame): Promise<Receipt | ErrorF> {
  d.send(f);
  for (;;) {
    const r = await d.next();
    if ((r.type === "receipt" || r.type === "error") && r.id === f.id) return r;
  }
}
async function sendAndReceipt(d: Daemon, f: ClientFrame): Promise<Receipt> {
  const r = await reply(d, f);
  if (r.type !== "receipt")
    throw new Error(`expected a receipt: ${JSON.stringify(r)}`);
  return r;
}

const delivers = (d: Daemon, msgId?: string) =>
  framesSeen(d).filter(
    (f) => f.type === "deliver" && (msgId === undefined || f.msg_id === msgId),
  );
const updates = (d: Daemon, msgId: string): Update[] =>
  framesSeen(d).filter(
    (f): f is Update => f.type === "receipt_update" && f.msg_id === msgId,
  );

const allParse = (...ds: Daemon[]) => {
  for (const d of ds)
    for (const t of d.raw)
      if (t !== "pong") expect(decodeServerFrame(t).ok, t).toBe(true);
};

const agentId = (ref: string, machineId: string) =>
  inOwnerHub(
    (s) =>
      s.storage.sql
        .exec<{ id: string }>(
          "select id from agents where native_ref = ? and machine_id = ?",
          ref,
          machineId,
        )
        .one().id,
  );
const receiptsFrom = (agent: string) =>
  inOwnerHub(
    (s) =>
      s.storage.sql
        .exec<{ n: number }>(
          "select count(*) as n from receipts where from_agent = ?",
          agent,
        )
        .one().n,
  );
const mailCount = () =>
  inOwnerHub(
    (s) =>
      s.storage.sql.exec<{ n: number }>("select count(*) as n from mail").one()
        .n,
  );
const keysOf = (agent: string) =>
  inOwnerHub(
    (s) =>
      s.storage.sql
        .exec<{ n: number }>(
          "select count(*) as n from send_keys where from_agent = ?",
          agent,
        )
        .one().n,
  );

/** A sender machine and a receiver machine, each with one agent in `n`. */
async function setup() {
  const sm = await machine("Sender");
  const tm = await machine("Target");
  const s = await ready(sm.token);
  const t = await ready(tm.token);
  const n = ns("idem");
  const sender = uniq("Sender");
  const receiver = uniq("Receiver");
  await agent(s, "sref", sender, n);
  await agent(t, "rref", receiver, n);
  const close = (...ds: Daemon[]) => {
    for (const d of [s, t, ...ds])
      try {
        d.close();
      } catch {
        // Already closed.
      }
  };
  return { s, t, sm, tm, n, sender, receiver, close };
}

async function offline(d: Daemon) {
  d.close();
  await d.closed;
  await new Promise((r) => setTimeout(r, 50));
}

describe("B14 idempotent send", () => {
  it("a resend returns the original msg_id and the recipient sees one deliver", async () => {
    const { s, t, sm, receiver, close } = await setup();
    const r1 = await sendAndReceipt(s, send("k1", "sref", receiver, "once"));
    expect(r1.state).toBe("pending");
    expect((await waitFor(t, "deliver")).msg_id).toBe(r1.msg_id);
    const r2 = await sendAndReceipt(s, send("k1", "sref", receiver, "once"));
    expect(r2).toEqual({
      v: 1,
      id: "k1",
      type: "receipt",
      msg_id: r1.msg_id,
      state: "pending",
    });
    await barrier(t);
    expect(delivers(t)).toHaveLength(1);
    expect(await receiptsFrom(await agentId("sref", sm.id))).toBe(1);
    allParse(s, t);
    close();
  });

  it("the to_name case is folded: the same name in another case is the same payload", async () => {
    const { s, t, receiver, close } = await setup();
    const r1 = await sendAndReceipt(s, send("k1", "sref", receiver));
    const r2 = await sendAndReceipt(
      s,
      send("k1", "sref", receiver.toUpperCase()),
    );
    expect(r2.msg_id).toBe(r1.msg_id);
    await barrier(t);
    expect(delivers(t)).toHaveLength(1);
    close();
  });

  it("a resend after the recipient acked reports delivered", async () => {
    const { s, t, receiver, close } = await setup();
    const r1 = await sendAndReceipt(s, send("k1", "sref", receiver));
    const d = await waitFor(t, "deliver");
    t.send(ack("a1", d.msg_id));
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      msg_id: r1.msg_id,
      state: "delivered",
    });
    const r2 = await sendAndReceipt(s, send("k1", "sref", receiver));
    // The send receipt is pending or refused on the wire; the current final
    // state follows as a receipt_update for the original msg_id.
    expect(r2).toMatchObject({ msg_id: r1.msg_id, state: "pending" });
    const u = await waitFor(s, "receipt_update");
    expect(u).toMatchObject({ msg_id: r1.msg_id, state: "delivered" });
    await barrier(t);
    await barrier(s);
    // receipt_update is idempotent per msg_id: the repeat is the same update
    // (only the frame id differs), which a daemon treats as a no-op.
    const [u1, u2] = updates(s, r1.msg_id).map(({ id: _, ...rest }) => rest);
    expect(updates(s, r1.msg_id)).toHaveLength(2);
    expect(u2).toEqual(u1);
    expect(u1).toEqual({
      v: 1,
      type: "receipt_update",
      msg_id: r1.msg_id,
      state: "delivered",
    });
    expect(delivers(t)).toHaveLength(1);
    allParse(s, t);
    close();
  });

  it("a resend after expiry reports expired and delivers nothing", async () => {
    const { s, t, sm, receiver, close } = await setup();
    await offline(t);
    const r1 = await sendAndReceipt(s, send("k1", "sref", receiver));
    await setClock(Date.now() + TTL + 1000);
    await runAlarm();
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      msg_id: r1.msg_id,
      state: "expired",
    });
    const r2 = await sendAndReceipt(s, send("k1", "sref", receiver));
    expect(r2).toMatchObject({ msg_id: r1.msg_id, state: "pending" });
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      msg_id: r1.msg_id,
      state: "expired",
    });
    expect(await receiptsFrom(await agentId("sref", sm.id))).toBe(1);
    expect(await mailCount()).toBe(0);
    allParse(s);
    close();
  });

  it("a refused send stores no key: its resend is evaluated again and never double-delivers", async () => {
    const { s, t, sm, n, close } = await setup();
    const me = await agentId("sref", sm.id);
    const ghost = uniq("Ghost");
    const r1 = await sendAndReceipt(s, send("k1", "sref", ghost));
    expect(r1).toMatchObject({ state: "refused", reason: "unknown_agent" });
    expect(await keysOf(me)).toBe(0);
    await agent(t, "gref", ghost, n);
    const r2 = await sendAndReceipt(s, send("k1", "sref", ghost));
    expect(r2.state).toBe("pending");
    expect(r2.msg_id).not.toBe(r1.msg_id);
    const r3 = await sendAndReceipt(s, send("k1", "sref", ghost));
    expect(r3).toEqual(r2);
    await barrier(t);
    expect(delivers(t)).toHaveLength(1);
    expect(await keysOf(me)).toBe(1);
    allParse(s, t);
    close();
  });

  it("a resend after inbox_full succeeds once the inbox drains, once", async () => {
    const { s, t, tm, sm, n, receiver, close } = await setup();
    const me = await agentId("sref", sm.id);
    await offline(t);
    for (let k = 0; k < LIMITS.inboxCap; k++)
      expect(
        (await sendAndReceipt(s, send(`fill${k}`, "sref", receiver))).state,
      ).toBe("pending");
    const r1 = await sendAndReceipt(s, send("k1", "sref", receiver, "later"));
    expect(r1).toMatchObject({ state: "refused", reason: "inbox_full" });
    expect(await keysOf(me)).toBe(LIMITS.inboxCap);
    // The inbox drains: the queued mail expires.
    await setClock(Date.now() + TTL + 1000);
    await runAlarm();
    const r2 = await sendAndReceipt(s, send("k1", "sref", receiver, "later"));
    expect(r2.state).toBe("pending");
    expect(r2.msg_id).not.toBe(r1.msg_id);
    expect(
      (await sendAndReceipt(s, send("k1", "sref", receiver, "later"))).msg_id,
    ).toBe(r2.msg_id);
    expect(await keysOf(me)).toBe(LIMITS.inboxCap + 1);
    // The recipient comes back: exactly one deliver of it.
    const t2 = await ready(tm.token);
    t2.send({ v: 1, id: "se", type: "sessions", open: ["rref"], closed: [] });
    await agent(t2, "rref", receiver, n);
    expect((await waitFor(t2, "deliver")).msg_id).toBe(r2.msg_id);
    await barrier(t2);
    expect(delivers(t2)).toHaveLength(1);
    allParse(s, t2);
    close(t2);
  });

  it("a reconnect (same agent ref, new socket) is still deduped", async () => {
    const { s, t, sm, n, sender, receiver, close } = await setup();
    const r1 = await sendAndReceipt(s, send("k1", "sref", receiver));
    await offline(s);
    const s2 = await ready(sm.token);
    s2.send({ v: 1, id: "se", type: "sessions", open: ["sref"], closed: [] });
    await agent(s2, "sref", sender, n);
    const r2 = await sendAndReceipt(s2, send("k1", "sref", receiver));
    expect(r2.msg_id).toBe(r1.msg_id);
    await barrier(t);
    expect(delivers(t)).toHaveLength(1);
    allParse(s2, t);
    close(s2);
  });

  it("a socket replacement (same machine, new socket) is still deduped", async () => {
    const { s, t, sm, n, sender, receiver, close } = await setup();
    const r1 = await sendAndReceipt(s, send("k1", "sref", receiver));
    const s2 = await daemon(sm.token);
    expect((await s.closed).reason).toBe("replaced");
    s2.send(hello());
    await waitFor(s2, "hello_ok");
    await agent(s2, "sref", sender, n);
    const r2 = await sendAndReceipt(s2, send("k1", "sref", receiver));
    expect(r2.msg_id).toBe(r1.msg_id);
    await barrier(t);
    expect(delivers(t)).toHaveLength(1);
    close(s2);
  });

  it("another agent using the same frame id is independent", async () => {
    const { s, t, n, receiver, close } = await setup();
    await agent(s, "sref2", uniq("Other"), n);
    const r1 = await sendAndReceipt(s, send("k1", "sref", receiver, "a"));
    const r2 = await sendAndReceipt(s, send("k1", "sref2", receiver, "a"));
    expect(r2.state).toBe("pending");
    expect(r2.msg_id).not.toBe(r1.msg_id);
    await barrier(t);
    expect(delivers(t)).toHaveLength(2);
    close();
  });

  it("the same id with another body, to_name or to_namespace is bad_frame: frame id reused", async () => {
    const { s, t, sm, n, receiver, close } = await setup();
    const other = uniq("Other");
    await agent(t, "oref", other, n);
    const r1 = await sendAndReceipt(s, send("k1", "sref", receiver, "a"));
    const me = await agentId("sref", sm.id);
    for (const f of [
      send("k1", "sref", receiver, "b"),
      send("k1", "sref", other, "a"),
      // Another namespace (the own one hashes as absent: adv-b14 P5).
      send("k1", "sref", receiver, "a", ns("elsewhere")),
    ]) {
      const r = await reply(s, f);
      expect(r).toEqual({
        v: 1,
        id: "k1",
        type: "error",
        code: "bad_frame",
        message: "frame id reused",
      });
    }
    expect(await receiptsFrom(me)).toBe(1);
    expect(await keysOf(me)).toBe(1);
    // The original key still answers.
    expect(
      (await sendAndReceipt(s, send("k1", "sref", receiver, "a"))).msg_id,
    ).toBe(r1.msg_id);
    await barrier(t);
    expect(delivers(t)).toHaveLength(1);
    allParse(s, t);
    close();
  });

  it("two resends back to back yield one delivery", async () => {
    const { s, t, receiver, close } = await setup();
    const f = send("k1", "sref", receiver, "race");
    s.send(f);
    s.send(f);
    s.send(f);
    const a = await waitFor(s, "receipt");
    const b = await waitFor(s, "receipt");
    const c = await waitFor(s, "receipt");
    expect(new Set([a.msg_id, b.msg_id, c.msg_id]).size).toBe(1);
    await barrier(t);
    expect(delivers(t)).toHaveLength(1);
    close();
  });

  it("after the retention window and the alarm sweep the key is gone and the id sends fresh", async () => {
    const { s, t, sm, receiver, close } = await setup();
    expect(SEND_KEY_RETAIN_MS).toBeGreaterThanOrEqual(TTL);
    const r1 = await sendAndReceipt(s, send("k1", "sref", receiver));
    const me = await agentId("sref", sm.id);
    expect(await keysOf(me)).toBe(1);
    // The alarm is armed for the key's expiry (no other work keeps it).
    await setClock(Date.now() + SEND_KEY_RETAIN_MS + 60_000);
    await runAlarm();
    expect(await keysOf(me)).toBe(0);
    const r2 = await sendAndReceipt(s, send("k1", "sref", receiver));
    expect(r2.state).toBe("pending");
    expect(r2.msg_id).not.toBe(r1.msg_id);
    await barrier(t);
    expect(delivers(t, r2.msg_id)).toHaveLength(1);
    close();
  });

  it("keeps a key for the whole retention window (an alarm just before it keeps the key)", async () => {
    const { s, sm, receiver, close } = await setup();
    const r1 = await sendAndReceipt(s, send("k1", "sref", receiver));
    const me = await agentId("sref", sm.id);
    await setClock(Date.now() + SEND_KEY_RETAIN_MS - 60_000);
    await runAlarm();
    expect(await keysOf(me)).toBe(1);
    expect((await sendAndReceipt(s, send("k1", "sref", receiver))).msg_id).toBe(
      r1.msg_id,
    );
    close();
  });

  it("a flood of unique ids keeps at most SEND_KEYS_PER_AGENT keys for the agent; other agents are unaffected", async () => {
    expect(SEND_KEYS_PER_AGENT).toBe(LIMITS.inboxCap * 4);
    const { s, t, sm, tm, n, sender, close } = await setup();
    // The other agent keeps its own keys.
    for (let k = 0; k < 3; k++)
      await sendAndReceipt(t, send(`o${k}`, "rref", sender));
    const other = await agentId("rref", tm.id);
    expect(await keysOf(other)).toBe(3);
    // Only accepted sends store keys, and only final keys are evicted: one
    // sink that acks every message, in waves under its inbox cap.
    const sink = uniq("Sink");
    await agent(t, "sink", sink, n);
    const N = SEND_KEYS_PER_AGENT * 5;
    const WAVE = LIMITS.inboxCap - 10;

    // Lift the frame budgets so the flood is not rate limited (a frozen
    // clock keeps the refill from clamping the tokens back to the burst).
    await setClock(Date.now() + 1000);
    await inHub((i, st) => {
      for (const id of [sm.id, tm.id])
        for (const ws of st.getWebSockets(id))
          BusHub.setFrameTokensForTests(i, ws, 1_000_000);
    });
    let first: Receipt | undefined;
    let last: Receipt | undefined;
    for (let k = 0; k <= N; k += WAVE) {
      const end = Math.min(k + WAVE, N + 1);
      for (let j = k; j < end - 1; j++) s.send(send(`f${j}`, "sref", sink));
      last = await sendAndReceipt(s, send(`f${end - 1}`, "sref", sink));
      expect(last.state).toBe("pending");
      if (k === 0) first = last;
      for (let j = k; j < end; j++) {
        const d = await waitFor(t, "deliver");
        t.send(ack(`a${j}`, d.msg_id));
      }
      await barrier(t);
    }
    const me = await agentId("sref", sm.id);
    expect(await keysOf(me)).toBe(SEND_KEYS_PER_AGENT);
    expect(await keysOf(other)).toBe(3);
    // The newest keys survive; the oldest was dropped and sends fresh.
    expect((await sendAndReceipt(s, send(`f${N}`, "sref", sink))).msg_id).toBe(
      last?.msg_id,
    );
    const again = await sendAndReceipt(s, send(`f${WAVE - 1}`, "sref", sink));
    expect(again.state).toBe("pending");
    expect(again.msg_id).not.toBe(first?.msg_id);
    expect(await keysOf(me)).toBe(SEND_KEYS_PER_AGENT);
    expect(await keysOf(other)).toBe(3);
    allParse(s, t);
    close();
  }, 60_000);
});
