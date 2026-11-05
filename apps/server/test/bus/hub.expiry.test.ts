// Ported from OpenBus v0.63.0 apps/server/test/hub.expiry.test.ts (#1291).
// Dropped: nothing.
// B7: the single alarm (ack timeout, lost bodies, TTL, mail sweep, retention),
// reconnect flush, closed-session expiry and missed receipt_update replay.
// The alarm is driven with runDurableObjectAlarm; time with BusHub.setTestClock
// (always set ahead of real time, reset after each test). Every frame a daemon
// receives is checked with decodeServerFrame (helpers.ts).
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  type ClientFrame,
  decodeServerFrame,
  LIMITS,
  MAILBOX_RETAIN_MS,
  type ServerFrame,
} from "@oa/bus-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BusHub, HELD_BYTES_CAP, SWEEP_BATCH } from "../../src/bus/hub.js";
import { migrateHub } from "../../src/bus/schema.js";
import {
  type Daemon,
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
const heldStats = () => inHub((i) => BusHub.heldStats(i));
/** Simulates an eviction: the in-memory held bodies are gone. */
const evictHeld = () => inHub((i) => BusHub.dropHeldForTests(i));
const alarmAt = () => inHub((_, s) => s.storage.getAlarm());
const runAlarmOnce = async () => runDurableObjectAlarm(await stub());

/** Runs the alarm until no closed session is queued for the close drain (B11). */
async function drainCloses() {
  for (let k = 0; k < 100; k++) {
    const queued = await inHub(
      (_, st) =>
        st.storage.sql
          .exec("select 1 from meta where key like 'close_drain:%' limit 1")
          .toArray().length,
    );
    if (queued === 0) return;
    await runAlarmOnce();
  }
}
/**
 * Runs the alarm, then again while a full batch re-armed it at now + 1 (as
 * the runtime would), so leftovers from other tests cannot hide a result.
 */
const runAlarm = async () => {
  await runAlarmOnce();
  for (
    let i = 0;
    i < 50 && clock !== null && (await alarmAt()) === clock + 1;
    i++
  )
    await runAlarmOnce();
};

afterEach(async () => {
  await setClock(null);
  // #1295: a close no longer releases held mail (it stays pending for the
  // reopen), so a test's leftovers must not fill the shared held cap.
  await evictHeld();
});

const HOUR = 3_600_000;
const TTL = MAILBOX_RETAIN_MS;

type Receipt = Extract<ServerFrame, { type: "receipt" }>;

let seq = 0;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;

const send = (id: string, from_ref: string, to_name: string, body = "hello") =>
  ({ v: 1, id, type: "send", from_ref, to_name, body }) as ClientFrame;
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

async function barrier(d: Daemon): Promise<void> {
  const id = `b${++seq}`;
  d.send(hello(id));
  for (;;) if ((await waitFor(d, "hello_ok")).id === id) return;
}

async function sendAndReceipt(d: Daemon, f: ClientFrame): Promise<Receipt> {
  d.send(f);
  for (;;) {
    const r = await waitFor(d, "receipt");
    if (r.id === f.id) return r;
  }
}

type Row = {
  state: string;
  reason: string | null;
  notifiedAt: number | null;
};
const receiptRow = (id: string) =>
  inOwnerHub(
    (s) =>
      s.storage.sql
        .exec<Row>(
          "select state, reason, notified_at as notifiedAt from receipts where id = ?",
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

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A valid 16-char msg_id: a 4-char tag, then `i` in base58. */
const msgId = (tag: string, i: number) => {
  let out = "";
  for (let k = 0; k < 12; k++, i = Math.floor(i / 58)) out = B58[i % 58] + out;
  return tag + out;
};

const types = (d: Daemon) => framesSeen(d).map((f) => f.type);
type Update = Extract<ServerFrame, { type: "receipt_update" }>;
const updates = (d: Daemon, msgId?: string): Update[] =>
  framesSeen(d).filter(
    (f): f is Update =>
      f.type === "receipt_update" &&
      (msgId === undefined || f.msg_id === msgId),
  );

/** Every received text is a valid server frame (beyond helpers' own check). */
const allParse = (...ds: Daemon[]) => {
  for (const d of ds)
    for (const t of d.raw)
      if (t !== "pong") expect(decodeServerFrame(t).ok, t).toBe(true);
};

/** A sender machine and a receiver machine, each with one agent in `n`. */
async function setup() {
  const sm = await machine("Sender");
  const tm = await machine("Target");
  const s = await ready(sm.token);
  const t = await ready(tm.token);
  const n = ns();
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

/** Closes a daemon's socket and waits until the hub has seen it go. */
async function offline(d: Daemon) {
  d.close();
  await d.closed;
  await new Promise((r) => setTimeout(r, 50));
}

/** A new socket for the machine, registering `ref` again (the reconnect). */
async function reconnect(token: string, ref: string, name: string, n: string) {
  const d = await ready(token);
  d.send({ v: 1, id: "se", type: "sessions", open: [ref], closed: [] });
  await agent(d, ref, name, n);
  return d;
}

describe("reconnect flush", () => {
  it("queues while the machine is offline and delivers on reconnect, keeping the mail row until the ack", async () => {
    const { s, t, tm, n, receiver, close } = await setup();
    await offline(t);
    const r = await sendAndReceipt(s, send("s1", "sref", receiver, "queued"));
    expect(r.state).toBe("pending");
    expect((await mailRow(r.msg_id))?.body).toBe("queued");

    const t2 = await reconnect(tm.token, "rref", receiver, n);
    const d = await waitFor(t2, "deliver");
    expect(d).toMatchObject({
      msg_id: r.msg_id,
      body: "queued",
      to_ref: "rref",
      namespace: n,
    });
    // A persisted body stays on disk until the ack; never moved into memory.
    expect((await heldStats()).ids).not.toContain(r.msg_id);
    expect((await mailRow(r.msg_id))?.body).toBe("queued");
    t2.send(ack("a1", d.msg_id));
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      msg_id: r.msg_id,
      state: "delivered",
    });
    expect(await mailRow(r.msg_id)).toBeNull();
    allParse(s, t2);
    close(t2);
  });

  it("an eviction right after a flush loses nothing: redelivered on the next reconnect, never expired", async () => {
    const { s, t, tm, n, receiver, close } = await setup();
    await offline(t);
    const r = await sendAndReceipt(s, send("s1", "sref", receiver, "durable"));
    const t2 = await reconnect(tm.token, "rref", receiver, n);
    expect((await waitFor(t2, "deliver")).msg_id).toBe(r.msg_id);
    await evictHeld();
    // Past the ack timeout: the alarm finds nothing lost.
    await setClock(Date.now() + LIMITS.ackTimeoutMs + 1000);
    await runAlarm();
    expect(await receiptRow(r.msg_id)).toMatchObject({ state: "pending" });
    expect((await mailRow(r.msg_id))?.body).toBe("durable");

    const t3 = await reconnect(tm.token, "rref", receiver, n);
    const d = await waitFor(t3, "deliver");
    expect(d).toMatchObject({ msg_id: r.msg_id, body: "durable" });
    t3.send(ack("a1", r.msg_id));
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      msg_id: r.msg_id,
      state: "delivered",
    });
    await barrier(s);
    expect(updates(s, r.msg_id)).toHaveLength(1);
    expect(
      framesSeen(s).some(
        (f) =>
          f.type === "receipt_update" &&
          f.state === "expired" &&
          f.msg_id === r.msg_id,
      ),
    ).toBe(false);
    close(t2, t3);
  });

  it("flushes oldest first, as a notice when oversized", async () => {
    const { s, t, tm, n, receiver, close } = await setup();
    await offline(t);
    const big = "z".repeat(LIMITS.inlineBodyBytes + 1);
    const ids: string[] = [];
    for (const [i, body] of ["one", big, "three"].entries())
      ids.push(
        (await sendAndReceipt(s, send(`s${i}`, "sref", receiver, body))).msg_id,
      );

    const t2 = await reconnect(tm.token, "rref", receiver, n);
    const got = [
      await waitFor(t2, "deliver"),
      await waitFor(t2, "deliver"),
      await waitFor(t2, "deliver"),
    ];
    expect(got.map((d) => d.msg_id)).toEqual(ids);
    expect(got[0]?.body).toBe("one");
    expect(got[1]?.body).toBeUndefined();
    expect(got[1]?.notice).toEqual({ size: big.length, msg_id: ids[1] });
    expect(got[2]?.body).toBe("three");
    // The notice body stays stored for fetch.
    expect((await mailRow(ids[1] as string))?.body).toBe(big);
    close(t2);
  });

  it("expires a pending receipt with no body anywhere instead of delivering it", async () => {
    const { s, t, tm, n, receiver, close } = await setup();
    const r = await sendAndReceipt(s, send("s1", "sref", receiver, "fragile"));
    await waitFor(t, "deliver");
    await evictHeld();
    const t2 = await reconnect(tm.token, "rref", receiver, n);
    const u = await waitFor(s, "receipt_update");
    expect(u).toMatchObject({ msg_id: r.msg_id, state: "expired" });
    expect(u.reason).toBeUndefined();
    await barrier(t2);
    expect(types(t2)).not.toContain("deliver");
    expect(await receiptRow(r.msg_id)).toMatchObject({
      state: "expired",
      reason: null,
    });
    close(t2);
  });

  it("respects the held cap: a full cap still flushes inline from mail, held bytes unchanged", async () => {
    const { s, t, tm, n, receiver, close } = await setup();
    // Frozen ahead of real time: a slow run must not cross the real ack
    // timeout (a real alarm would spill the filler's held bodies).
    await setClock(Date.now() + 60_000);
    await offline(t);
    const body = "q".repeat(LIMITS.inlineBodyBytes);
    const queued = [
      (await sendAndReceipt(s, send("q1", "sref", receiver, body))).msg_id,
      (await sendAndReceipt(s, send("q2", "sref", receiver, body))).msg_id,
    ];

    // Fill held memory up to the cap on a third machine.
    const fm = await machine("Filler");
    const f = await ready(fm.token);
    const refs: string[] = [];
    let t2: Daemon | null = null;
    try {
      for (let a = 0; a < 6; a++) {
        const name = uniq(`F${a}`);
        await agent(f, `f${a}`, name, n);
        refs.push(`f${a}`);
        // One sender agent per batch: B14 caps an agent's pending sends.
        await agent(s, `fs${a}`, uniq(`FS${a}`), n);
        for (let i = 0; i < LIMITS.inboxCap; i++)
          s.send(send(`f${a}x${i}`, `fs${a}`, name, body));
        for (let i = 0; i < LIMITS.inboxCap; i++) await waitFor(f, "deliver");
        f.raw.length = 0;
        s.raw.length = 0;
      }
      const before = await heldStats();
      expect(before.bytes + LIMITS.inlineBodyBytes).toBeGreaterThan(
        HELD_BYTES_CAP,
      );

      t2 = await reconnect(tm.token, "rref", receiver, n);
      for (const id of queued) {
        const d = await waitFor(t2, "deliver");
        expect(d.msg_id).toBe(id);
        expect(d.body?.length).toBe(body.length);
        expect((await mailRow(id))?.body.length).toBe(body.length);
      }
      const after = await heldStats();
      expect(after.bytes).toBe(before.bytes);
      expect(after.bytes).toBeLessThanOrEqual(HELD_BYTES_CAP);
      for (const id of queued) expect(after.ids).not.toContain(id);
    } finally {
      // Always free the filler's held bodies, so a failure cannot cascade.
      for (const ref of refs)
        f.send({ v: 1, id: "dn", type: "agent_down", agent_ref: ref });
      await barrier(f);
      // A close spends CLOSE_INLINE_BATCH inline; the alarm drains the rest.
      await drainCloses();
      close(f, ...(t2 ? [t2] : []));
    }
  }, 30_000);

  it("redelivery plus a late ack: delivered once, the sender told once", async () => {
    const { s, t, tm, n, receiver, close } = await setup();
    const r = await sendAndReceipt(s, send("s1", "sref", receiver, "twice"));
    expect((await waitFor(t, "deliver")).msg_id).toBe(r.msg_id);
    // The daemon reconnects before acking: the hub redelivers the held body.
    const t2 = await reconnect(tm.token, "rref", receiver, n);
    const again = await waitFor(t2, "deliver");
    expect(again).toMatchObject({ msg_id: r.msg_id, body: "twice" });
    t2.send(ack("a1", r.msg_id));
    t2.send(ack("a2", r.msg_id));
    t.send(ack("a3", r.msg_id)); // the replaced socket: ignored
    await barrier(t2);
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      state: "delivered",
    });
    await barrier(s);
    expect(updates(s, r.msg_id)).toHaveLength(1);
    close(t2);
  });
});

describe("alarm", () => {
  it("ack timeout persists the held body; the receipt stays pending; reconnect delivers it", async () => {
    const { s, t, tm, n, receiver, close } = await setup();
    const r = await sendAndReceipt(s, send("s1", "sref", receiver, "slow"));
    await waitFor(t, "deliver");
    expect((await heldStats()).ids).toContain(r.msg_id);
    const before = (await heldStats()).bytes;

    await setClock(Date.now() + LIMITS.ackTimeoutMs + 1000);
    await runAlarm();
    const st = await heldStats();
    expect(st.ids).not.toContain(r.msg_id);
    expect(st.bytes).toBe(before - 256);
    expect((await mailRow(r.msg_id))?.body).toBe("slow");
    expect(await receiptRow(r.msg_id)).toMatchObject({ state: "pending" });
    await barrier(s);
    expect(updates(s, r.msg_id)).toHaveLength(0);
    // Not re-sent by the alarm.
    await barrier(t);
    expect(types(t).filter((x) => x === "deliver")).toHaveLength(1);

    const t2 = await reconnect(tm.token, "rref", receiver, n);
    const d = await waitFor(t2, "deliver");
    expect(d).toMatchObject({ msg_id: r.msg_id, body: "slow" });
    t2.send(ack("a1", r.msg_id));
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      state: "delivered",
    });
    close(t2);
  });

  it("expires a lost body after the ack timeout; a late ack cannot deliver it", async () => {
    const { s, t, receiver, close } = await setup();
    const r = await sendAndReceipt(s, send("s1", "sref", receiver, "gone"));
    await waitFor(t, "deliver");
    await evictHeld();
    await setClock(Date.now() + LIMITS.ackTimeoutMs + 1000);
    await runAlarm();
    const u = await waitFor(s, "receipt_update");
    expect(u).toMatchObject({ msg_id: r.msg_id, state: "expired" });
    expect(u.reason).toBeUndefined();
    t.send(ack("a1", r.msg_id));
    await barrier(t);
    await barrier(s);
    expect(await receiptRow(r.msg_id)).toMatchObject({ state: "expired" });
    expect(updates(s, r.msg_id)).toHaveLength(1);
    close();
  });

  it("expires queued mail at the TTL and deletes its body", async () => {
    const { s, t, receiver, close } = await setup();
    await offline(t);
    const r = await sendAndReceipt(s, send("s1", "sref", receiver, "later"));
    await setClock(Date.now() + TTL + 5000);
    await runAlarm();
    const u = await waitFor(s, "receipt_update");
    expect(u).toMatchObject({ msg_id: r.msg_id, state: "expired" });
    expect(u.reason).toBeUndefined();
    expect(await mailRow(r.msg_id)).toBeNull();
    expect(await receiptRow(r.msg_id)).toMatchObject({ state: "expired" });
    close();
  });

  it("deletes an acked notice's body at the TTL; the receipt stays delivered", async () => {
    const { s, t, receiver, close } = await setup();
    const big = "n".repeat(LIMITS.inlineBodyBytes + 1);
    const r = await sendAndReceipt(s, send("s1", "sref", receiver, big));
    expect((await waitFor(t, "deliver")).notice).toBeDefined();
    t.send(ack("a1", r.msg_id));
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      state: "delivered",
    });
    expect(await mailRow(r.msg_id)).not.toBeNull();
    await setClock(Date.now() + TTL + 5000);
    await runAlarm();
    expect(await mailRow(r.msg_id)).toBeNull();
    expect(await receiptRow(r.msg_id)).toMatchObject({ state: "delivered" });
    await barrier(s);
    expect(updates(s, r.msg_id)).toHaveLength(1);
    close();
  });

  it("deletes a pending notice's body with its receipt at the TTL", async () => {
    const { s, t, receiver, close } = await setup();
    const big = "p".repeat(LIMITS.inlineBodyBytes + 1);
    const r = await sendAndReceipt(s, send("s1", "sref", receiver, big));
    await waitFor(t, "deliver");
    await setClock(Date.now() + TTL + 5000);
    await runAlarm();
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      msg_id: r.msg_id,
      state: "expired",
    });
    expect(await mailRow(r.msg_id)).toBeNull();
    close();
  });

  it("re-arms at once when a batch is full; each run expires at most SWEEP_BATCH", async () => {
    const t0 = Date.now() + 2 * HOUR;
    const ids = Array.from({ length: 205 }, (_, i) => msgId("Bat7", i));
    await inOwnerHub((s) => {
      for (const id of ids)
        s.storage.sql.exec(
          `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at)
           values (?, 'owner', 'n', 'nobody', 'N', 'nobody', 'N', 'pending', 1, ?, ?)`,
          id,
          t0 - TTL - 10,
          t0 - 10,
        );
    });
    await setClock(t0);
    const pendingLeft = () =>
      inOwnerHub(
        (s) =>
          s.storage.sql
            .exec<{ n: number }>(
              "select count(*) as n from receipts where id like 'Bat7%' and state = 'pending'",
            )
            .one().n,
      );
    const before = await pendingLeft();
    await runAlarmOnce();
    expect(before - (await pendingLeft())).toBeLessThanOrEqual(SWEEP_BATCH);
    expect(await pendingLeft()).toBeGreaterThan(0);
    expect(await alarmAt()).toBe(t0 + 1);
    for (let i = 0; i < 20 && (await pendingLeft()) > 0; i++)
      await runAlarmOnce();
    expect(await pendingLeft()).toBe(0);
  });

  it("is not callable over RPC", async () => {
    const s = (await stub()) as unknown as Record<
      string,
      () => Promise<unknown>
    >;
    await expect(Promise.resolve().then(() => s.alarm?.())).rejects.toThrow(
      /reserved method/,
    );
  });
});

describe("closed sessions", () => {
  it("sessions{closed} keeps queued mail pending (away); the same ref reopening gets it, once", async () => {
    const { s, t, tm, n, receiver, close } = await setup();
    await offline(t);
    const r = await sendAndReceipt(s, send("s1", "sref", receiver, "queued"));
    const t2 = await ready(tm.token);
    t2.send({ v: 1, id: "se", type: "sessions", open: [], closed: ["rref"] });
    await barrier(t2);
    expect(await receiptRow(r.msg_id)).toMatchObject({ state: "pending" });
    expect((await mailRow(r.msg_id))?.body).toBe("queued");
    // The same session ref opens again: the pending mail comes back.
    await agent(t2, "rref", receiver, n);
    const d = await waitFor(t2, "deliver");
    expect(d).toMatchObject({ msg_id: r.msg_id, body: "queued" });
    t2.send(ack("a2", r.msg_id));
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      msg_id: r.msg_id,
      state: "delivered",
    });
    await barrier(s);
    expect(updates(s, r.msg_id)).toHaveLength(1);
    close(t2);
  });

  it("sessions{closed} mail expires at the end of the away reservation, the sender told once", async () => {
    const { s, t, tm, receiver, close } = await setup();
    await offline(t);
    const r = await sendAndReceipt(s, send("s1", "sref", receiver, "queued"));
    const t2 = await ready(tm.token);
    t2.send({ v: 1, id: "se", type: "sessions", open: [], closed: ["rref"] });
    await barrier(t2);
    await setClock(Date.now() + TTL + 5000);
    await runAlarm();
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      msg_id: r.msg_id,
      state: "expired",
    });
    expect(await mailRow(r.msg_id)).toBeNull();
    await barrier(s);
    expect(updates(s, r.msg_id)).toHaveLength(1);
    close(t2);
  });

  it("agent_down keeps held mail pending (stored at the ack timeout); a reopen gets it", async () => {
    const { s, t, n, receiver, close } = await setup();
    const r = await sendAndReceipt(s, send("s1", "sref", receiver, "held"));
    await waitFor(t, "deliver");
    expect((await heldStats()).ids).toContain(r.msg_id);
    t.send({ v: 1, id: "dn", type: "agent_down", agent_ref: "rref" });
    await barrier(t);
    expect(await receiptRow(r.msg_id)).toMatchObject({ state: "pending" });
    await setClock(Date.now() + LIMITS.ackTimeoutMs + 1000);
    await runAlarm();
    expect((await mailRow(r.msg_id))?.body).toBe("held");
    await agent(t, "rref", receiver, n);
    expect(
      (await waitFor(t, "deliver")) as { msg_id: string; body: string },
    ).toMatchObject({ msg_id: r.msg_id, body: "held" });
    expect(updates(s, r.msg_id)).toHaveLength(0);
    close();
  });

  it("agent_down: a late ack from the closing session still settles the held mail once (the machine is the recipient), and a reopen redelivers nothing", async () => {
    const { s, t, n, receiver, close } = await setup();
    const r = await sendAndReceipt(s, send("s1", "sref", receiver, "held"));
    await waitFor(t, "deliver");
    t.send({ v: 1, id: "dn", type: "agent_down", agent_ref: "rref" });
    t.send(ack("a1", r.msg_id));
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      msg_id: r.msg_id,
      state: "delivered",
    });
    await agent(t, "rref", receiver, n);
    await barrier(t);
    await barrier(s);
    expect(types(t).filter((x) => x === "deliver")).toHaveLength(1);
    expect(updates(s, r.msg_id)).toHaveLength(1);
    close();
  });
});

describe("missed receipt updates", () => {
  it("an offline sender gets exactly one expired update when it comes back", async () => {
    const { s, t, sm, n, sender, receiver, close } = await setup();
    await offline(t);
    const r = await sendAndReceipt(s, send("s1", "sref", receiver, "later"));
    await offline(s);
    await setClock(Date.now() + TTL + 5000);
    await runAlarm();
    expect(await receiptRow(r.msg_id)).toMatchObject({
      state: "expired",
      notifiedAt: null,
    });

    const s2 = await reconnect(sm.token, "sref", sender, n);
    const u = await waitFor(s2, "receipt_update");
    expect(u).toMatchObject({ msg_id: r.msg_id, state: "expired" });
    expect(u.reason).toBeUndefined();
    expect((await receiptRow(r.msg_id))?.notifiedAt).toEqual(
      expect.any(Number),
    );
    await agent(s2, "sref", sender, n);
    await barrier(s2);
    expect(updates(s2, r.msg_id)).toHaveLength(1);
    allParse(s2);
    close(s2);
  });

  it("an offline sender gets exactly one delivered update when it comes back", async () => {
    const { s, t, sm, n, sender, receiver, close } = await setup();
    const r = await sendAndReceipt(s, send("s1", "sref", receiver, "hi"));
    await waitFor(t, "deliver");
    await offline(s);
    t.send(ack("a1", r.msg_id));
    await barrier(t);
    expect(await receiptRow(r.msg_id)).toMatchObject({
      state: "delivered",
      notifiedAt: null,
    });

    const s2 = await reconnect(sm.token, "sref", sender, n);
    expect(await waitFor(s2, "receipt_update")).toMatchObject({
      msg_id: r.msg_id,
      state: "delivered",
    });
    await agent(s2, "sref", sender, n);
    await barrier(s2);
    expect(updates(s2, r.msg_id)).toHaveLength(1);
    close(s2);
  });

  it("no duplicate when the sender was online", async () => {
    const { s, t, n, sender, receiver, close } = await setup();
    const r = await sendAndReceipt(s, send("s1", "sref", receiver, "hi"));
    await waitFor(t, "deliver");
    t.send(ack("a1", r.msg_id));
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      state: "delivered",
    });
    expect((await receiptRow(r.msg_id))?.notifiedAt).toEqual(
      expect.any(Number),
    );
    await agent(s, "sref", sender, n);
    await barrier(s);
    expect(updates(s, r.msg_id)).toHaveLength(1);
    close();
  });

  it("replays in batches of SWEEP_BATCH and the alarm sends the rest", async () => {
    const { s, sm, n, sender, close } = await setup();
    const from = await agentId("sref", sm.id);
    const now = Date.now();
    const ids = Array.from({ length: SWEEP_BATCH + 3 }, (_, i) =>
      msgId("Rep7", i),
    );
    await inOwnerHub((st) => {
      for (const [i, id] of ids.entries())
        st.storage.sql.exec(
          `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at)
           values (?, 'owner', ?, 'nobody', 'N', ?, 'S', 'expired', 1, ?, ?)`,
          id,
          n,
          from,
          now + i,
          now + i + TTL,
        );
    });
    await agent(s, "sref", sender, n);
    await barrier(s);
    const first = updates(s).filter((u) => u.msg_id.startsWith("Rep7"));
    expect(first).toHaveLength(SWEEP_BATCH);
    expect(first.map((u) => u.msg_id)).toEqual(ids.slice(0, SWEEP_BATCH));
    await runAlarm();
    await barrier(s);
    const all = updates(s).filter((u) => u.msg_id.startsWith("Rep7"));
    expect(all.map((u) => u.msg_id)).toEqual(ids);
    close();
  });

  it("retention deletes final receipts told, or finalized untold, over 24 h ago", async () => {
    const t0 = Date.now() + 3 * HOUR;
    const day = 24 * HOUR;
    // [id, state, notified_at, expires_at, final_at]
    const rows: [string, string, number | null, number, number | null][] = [
      ["B7ret-notified-old", "delivered", t0 - day - 10, t0, t0 - day - 20],
      ["B7ret-notified-new", "delivered", t0 - 10, t0, t0 - 20],
      ["B7ret-unnotif-old", "expired", null, t0 - day - 10, t0 - day - 10],
      // Expired long ago but finalized recently (a late alarm): kept.
      ["B7ret-unnotif-late", "expired", null, t0 - 2 * day, t0 - 10],
      ["B7ret-unnotif-new", "refused", null, t0 - 10, t0 - 10],
      ["B7ret-pending-old", "pending", null, t0 + TTL, null],
    ];
    await inOwnerHub((s) => {
      for (const [id, state, notified, expires, final] of rows)
        s.storage.sql.exec(
          `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at, notified_at, final_at)
           values (?, 'owner', 'n', 'nobody', 'N', 'nobody', 'N', ?, 1, ?, ?, ?, ?)`,
          id,
          state,
          expires - TTL,
          expires,
          notified,
          final,
        );
    });
    await setClock(t0);
    await runAlarm();
    const left = await inOwnerHub((s) =>
      s.storage.sql
        .exec<{ id: string }>(
          "select id from receipts where id like 'B7ret-%' order by id",
        )
        .toArray()
        .map((r) => r.id),
    );
    expect(left).toEqual([
      "B7ret-notified-new",
      "B7ret-pending-old",
      "B7ret-unnotif-late",
      "B7ret-unnotif-new",
    ]);
  });
});

describe("batch bound", () => {
  it("is 50, and covers a full inbox (flush and close rely on it)", () => {
    expect(SWEEP_BATCH).toBe(50);
    expect(LIMITS.inboxCap).toBeLessThanOrEqual(SWEEP_BATCH);
  });
});

describe("retention vs a late alarm (adv-B7 F3)", () => {
  it("a receipt expired by a run more than 24 h late is kept until the offline sender is told", async () => {
    const { s, sm, n, sender, close } = await setup();
    const from = await agentId("sref", sm.id);
    await offline(s);
    const t0 = Date.now() + 26 * HOUR;
    const id = msgId("T1aa", 1);
    await inOwnerHub((st) =>
      st.storage.sql.exec(
        `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at)
         values (?, 'owner', ?, 'nobody', 'N', ?, 'S', 'pending', 1, ?, ?)`,
        id,
        n,
        from,
        Date.now() - TTL,
        Date.now(),
      ),
    );
    await setClock(t0);
    await runAlarm();
    expect(await receiptRow(id)).toMatchObject({
      state: "expired",
      notifiedAt: null,
    });
    await setClock(null);
    const s2 = await reconnect(sm.token, "sref", sender, n);
    await barrier(s2);
    expect(updates(s2, id).map((u) => u.state)).toEqual(["expired"]);
    close(s2);
  });
});

const B6_RECEIPTS = `
create table receipts (
  id text primary key, org_id text not null, namespace text not null, to_agent text,
  to_name text not null, from_agent text not null, from_name text not null, state text not null,
  reason text, size integer not null, created_at integer not null, expires_at integer not null,
  acked_at integer
);
create index if not exists receipts_to on receipts(to_agent, state);
create index if not exists receipts_due on receipts(state, expires_at);`;

// Last in the file: it replaces the owner hub's receipts table.
describe("a hub created with the B6 schema (adv-B7 F1, F2, F4)", () => {
  it("migrates once: told receipts are not replayed, closed-session mail expires, the wake arms the alarm", async () => {
    const { s, t, sm, tm, n, sender, receiver, close } = await setup();
    const from = await agentId("sref", sm.id);
    const to = await agentId("rref", tm.id);
    const gone = uniq("Gone");
    await agent(t, "gref", gone, n);
    const goneId = await agentId("gref", tm.id);
    t.send({ v: 1, id: "dn", type: "agent_down", agent_ref: "gref" });
    await barrier(t);
    await offline(t);

    const now = Date.now();
    const told = msgId("S6tk", 1);
    const queued = msgId("S6qu", 1);
    const spilled = msgId("S6sp", 1);
    await inOwnerHub(async (st) => {
      const sql = st.storage.sql;
      sql.exec("drop table receipts");
      sql.exec(B6_RECEIPTS);
      // A B6 hub's agents predate the B11 session columns: the backfill is 0.
      sql.exec(
        "update agents set session_started_at = 0, session_start_rowid = 0",
      );
      const ins = (
        id: string,
        toAgent: string,
        toName: string,
        state: string,
        created: number,
      ) =>
        sql.exec(
          `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at, acked_at)
           values (?, 'owner', ?, ?, ?, ?, ?, ?, 5, ?, ?, ?)`,
          id,
          n,
          toAgent,
          toName,
          from,
          sender,
          state,
          created,
          created + TTL,
          state === "delivered" ? created + 1 : null,
        );
      ins(told, to, receiver, "delivered", now - 60_000); // B6 told it live
      ins(queued, to, receiver, "pending", now - 60_000);
      sql.exec(
        "insert into mail (id, org_id, body, created_at, expires_at) values (?, 'owner', 'b6-queued', ?, ?)",
        queued,
        now - 60_000,
        now - 60_000 + TTL,
      );
      // B6 spilled a closed agent's held body to mail; still pending.
      ins(spilled, goneId, gone, "pending", now - 30_000);
      sql.exec(
        "insert into mail (id, org_id, body, created_at, expires_at) values (?, 'owner', 'b6-spilled', ?, ?)",
        spilled,
        now - 30_000,
        now - 30_000 + TTL,
      );
      await st.storage.deleteAlarm(); // B6 never set one
    });
    // The wake: a fresh instance runs the schema and the one-time migration.
    await inHub((_, st) => {
      new BusHub(st, e);
    });
    await inHub((_, st) => {
      migrateHub(st.storage.sql); // idempotent
    });

    // F1: already final rows are backfilled, so nothing is replayed.
    type Mig = {
      notifiedAt: number | null;
      finalAt: number | null;
      state: string;
      reason: string | null;
    };
    const mig = (id: string) =>
      inOwnerHub((st) =>
        st.storage.sql
          .exec<Mig>(
            "select notified_at as notifiedAt, final_at as finalAt, state, reason from receipts where id = ?",
            id,
          )
          .one(),
      );
    expect(await mig(told)).toMatchObject({
      notifiedAt: now - 60_000 + 1,
      finalAt: now - 60_000 + 1,
    });
    s.raw.length = 0;
    await agent(s, "sref", sender, n);
    await barrier(s);
    expect(updates(s, told)).toHaveLength(0);

    // F4: B6 closed-session mail expired as recipient_closed, body dropped,
    // and the sender hears it through the normal path (here: replay above).
    expect(await mig(spilled)).toMatchObject({
      state: "expired",
      reason: "recipient_closed",
      notifiedAt: expect.any(Number),
    });
    expect(updates(s, spilled).map((u) => [u.state, u.reason])).toEqual([
      ["expired", "recipient_closed"],
    ]);
    expect(await mailRow(spilled)).toBeNull();
    expect((await mig(queued)).state).toBe("pending");

    // F2: the wake armed the alarm for the pending B6 mail.
    const armed = await alarmAt();
    expect(armed).not.toBeNull();
    expect(armed as number).toBeLessThanOrEqual(now - 60_000 + TTL);

    // A flush also arms for the rows it touches.
    await inHub((_, st) => st.storage.deleteAlarm());
    const t2 = await reconnect(tm.token, "rref", receiver, n);
    expect((await waitFor(t2, "deliver")).msg_id).toBe(queued);
    expect(await alarmAt()).toBe(now - 60_000 + TTL);

    // The reopened closed session gets nothing back.
    await agent(t2, "gref", gone, n);
    await barrier(t2);
    expect(
      framesSeen(t2).filter(
        (f) => f.type === "deliver" && f.msg_id === spilled,
      ),
    ).toHaveLength(0);
    close(t2);
  });
});
