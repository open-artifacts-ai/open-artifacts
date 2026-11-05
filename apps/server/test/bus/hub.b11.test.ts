// Ported from OpenBus v0.63.0 apps/server/test/hub.b11.test.ts (#1291).
// Dropped: the dashboard socket's frame budget, the OIDC-state cap (no
// OIDC states in the hub) and the token check in the log test (tokens live in D1).
// B11 hardening on the hub: per-socket frame budget, live-agent caps, bounded
// bulk work (sessions{closed}, close cleanup, persisted revoke drain) and the
// hub's structured logs. Every test runs on its own hub (newUniqueId).
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  AGENT_CAP_MESSAGES,
  type ClientFrame,
  decodeServerFrame,
  encodeFrame,
  LIMITS,
  MAILBOX_RETAIN_MS,
  newId,
  PONG,
  type ServerFrame,
} from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTHZ_AT_HEADER,
  BusHub,
  CLOSE_INLINE_BATCH,
  CONNECT_DO_PATH,
  FRAME_BUDGET,
  MACHINE_ID_HEADER,
  MACHINE_LABEL_HEADER,
  OWNER_ORG_ID,
  SWEEP_BATCH,
} from "../../src/bus/hub.js";
import { e, hello, ns, up } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

type BusHubStub = DurableObjectStub<BusHub>;
const busNs = () => e.BUS_HUB as DurableObjectNamespace<BusHub>;
const freshHub = (): BusHubStub =>
  busNs().get(busNs().newUniqueId()) as unknown as BusHubStub;
const stubOf = (h: BusHubStub) => h as unknown as DurableObjectStub<BusHub>;
const inHub = <R>(h: BusHubStub, fn: (i: BusHub, s: DurableObjectState) => R) =>
  runInDurableObject(stubOf(h), (i: BusHub, s) => fn(i, s));
const clock = (h: BusHubStub, ms: number | null) =>
  inHub(h, (i) => BusHub.setTestClock(i, ms));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

type D = {
  ws: WebSocket;
  seen: ServerFrame[];
  next: () => Promise<ServerFrame>;
  send: (f: ClientFrame) => void;
  closed: Promise<{ code: number; reason: string }>;
  isClosed: () => boolean;
};

function wire(ws: WebSocket, decode: boolean): Omit<D, "send"> {
  ws.accept();
  const queue: ServerFrame[] = [];
  const waiting: ((f: ServerFrame) => void)[] = [];
  const seen: ServerFrame[] = [];
  let done = false;
  ws.addEventListener("message", (ev) => {
    const t = String(ev.data);
    if (!decode || t === PONG) return;
    const r = decodeServerFrame(t);
    expect(r.ok, `not a server frame: ${t}`).toBe(true);
    if (!r.ok) return;
    seen.push(r.frame);
    const w = waiting.shift();
    if (w) w(r.frame);
    else queue.push(r.frame);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (ev) => {
      done = true;
      resolve({ code: ev.code, reason: ev.reason });
    }),
  );
  const next = () => {
    const f = queue.shift();
    if (f) return Promise.resolve(f);
    return new Promise<ServerFrame>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out")), 15_000);
      waiting.push((x) => {
        clearTimeout(t);
        resolve(x);
      });
    });
  };
  return { ws, seen, next, closed, isClosed: () => done };
}

/** A daemon on `h`, through the DO's /connect as the Worker forwards it. */
async function daemonOn(
  h: BusHubStub,
  machineId: string,
  label = "MacBook",
): Promise<D> {
  const res = await stubOf(h).fetch(`https://hub.internal${CONNECT_DO_PATH}`, {
    headers: {
      Upgrade: "websocket",
      [MACHINE_ID_HEADER]: machineId,
      [MACHINE_LABEL_HEADER]: label,
      [AUTHZ_AT_HEADER]: String(Date.now()),
    },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  return { ...wire(ws, true), send: (f) => ws.send(encodeFrame(f)) };
}

async function until<T extends ServerFrame["type"]>(d: D, type: T) {
  for (let i = 0; i < 5000; i++) {
    const f = await d.next();
    if (f.type === type) return f as Extract<ServerFrame, { type: T }>;
  }
  throw new Error(`no ${type}`);
}

/** A machine on `h`: the hub's mirror row (the token lives in D1). */
async function machineOn(h: BusHubStub, label = "MacBook") {
  const id = newId();
  await inHub(h, (_, s) =>
    s.storage.sql.exec(
      "insert into machines (id, org_id, label, created_at) values (?, ?, ?, ?)",
      id,
      OWNER_ORG_ID,
      label,
      Date.now(),
    ),
  );
  return { id, label };
}

/** Seeds `n` live agents on a machine straight into SQL (bypassing caps). */
const seedAgents = (
  h: BusHubStub,
  machineId: string,
  n: number,
  namespace: string,
) =>
  inHub(h, (_, s) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = newId();
      ids.push(id);
      s.storage.sql.exec(
        `insert into agents (id, org_id, namespace, name, kind, machine_id, native_ref, global, live, updated_at)
         values (?, ?, ?, ?, 'claude-code', ?, ?, 0, 1, 0)`,
        id,
        OWNER_ORG_ID,
        namespace,
        `seed-${machineId.slice(0, 4)}-${i}`,
        machineId,
        `seed_${i}`,
      );
    }
    return ids;
  });

/** Seeds receipts to `toAgent` (state as given), with a mail row when `body`. */
const seedReceipts = (
  h: BusHubStub,
  toAgent: string,
  n: number,
  opts: {
    state: "pending" | "delivered";
    body: boolean;
    now: number;
    from?: string;
  },
) =>
  inHub(h, (_, s) => {
    const ids: string[] = [];
    const exp = opts.now + MAILBOX_RETAIN_MS;
    for (let i = 0; i < n; i++) {
      const id = newId();
      ids.push(id);
      s.storage.sql.exec(
        `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at, acked_at, final_at)
         values (?, ?, 'seed', ?, 'to', ?, 'from', ?, ?, ?, ?, ?, ?)`,
        id,
        OWNER_ORG_ID,
        toAgent,
        opts.from ?? "nobody",
        opts.state,
        LIMITS.inlineBodyBytes + 1,
        opts.now,
        exp,
        opts.state === "delivered" ? opts.now : null,
        opts.state === "delivered" ? opts.now : null,
      );
      if (opts.body)
        s.storage.sql.exec(
          "insert into mail (id, org_id, to_agent, body, created_at, expires_at) values (?, ?, ?, 'b', ?, ?)",
          id,
          OWNER_ORG_ID,
          toAgent,
          opts.now,
          exp,
        );
    }
    return ids;
  });

const count = (h: BusHubStub, q: string, ...b: SqlStorageValue[]) =>
  inHub(
    h,
    (_, s) => s.storage.sql.exec<{ n: number }>(q, ...b).toArray()[0]?.n ?? 0,
  );

/**
 * Runs the alarm until `done` (the alarm may also fire on its own at now + 1,
 * so a false from runDurableObjectAlarm is not "finished").
 */
async function drain(h: BusHubStub, done: () => Promise<boolean>) {
  for (let k = 0; k < 200; k++) {
    if (await done()) return;
    await runDurableObjectAlarm(stubOf(h));
    await tick(5);
  }
}

/** console.log lines that are JSON events named `evt`. */
const events = (spy: { mock: { calls: unknown[][] } }, evt: string) =>
  spy.mock.calls
    .map((c) => {
      try {
        return JSON.parse(String(c[0])) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, unknown> => x?.evt === evt);

// ------------------------------------------------------------ frame budget

/** An ack for an unknown msg_id: a frame the hub ignores without a reply. */
const junkAck = (): ClientFrame => ({
  v: 1,
  id: newId(),
  type: "ack",
  msg_id: newId(),
});
const acks = (d: D, n: number) => {
  for (let k = 0; k < n; k++) d.send(junkAck());
};
const HOUR = 3_600_000;

describe("per-socket frame budget (token bucket)", () => {
  it("refills 50/s with a burst of 512 (manager ruling M3)", () => {
    expect(FRAME_BUDGET).toEqual({ refillPerSec: 50, burst: 512 });
  });

  it("a reconnect (hello, 200 agent_ups, acks for a 50-message flush) as fast as possible is never closed", async () => {
    const h = freshHub();
    const n = ns("reconnect");
    const m = await machineOn(h);
    const ids = await seedAgents(h, m.id, LIMITS.maxAgentsPerMachine, n);
    await seedReceipts(h, ids[0] as string, LIMITS.inboxCap, {
      state: "pending",
      body: true,
      now: Date.now(),
    });
    const d = await daemonOn(h, m.id);
    d.send(hello("h"));
    for (let i = 0; i < LIMITS.maxAgentsPerMachine; i++)
      d.send(up(`u${i}`, `seed_${i}`, `seed-${m.id.slice(0, 4)}-${i}`, n));
    for (let k = 0; k < LIMITS.inboxCap; k++) {
      const f = await until(d, "deliver");
      d.send({ v: 1, id: `a${k}`, type: "ack", msg_id: f.msg_id });
    }
    d.send(hello("sync"));
    for (;;) if ((await until(d, "hello_ok")).id === "sync") break;
    expect(d.isClosed()).toBe(false);
    expect(
      await count(
        h,
        "select count(*) as n from receipts where state = 'delivered'",
      ),
    ).toBe(LIMITS.inboxCap);
  });

  it("a sustained flood well above the refill rate is closed with 1008 rate limited, logged once", async () => {
    const log = vi.spyOn(console, "log");
    const h = freshHub();
    // A frozen hub clock: no refill, so the burst runs out at a fixed frame
    // count however slowly a loaded machine sends (OpenBus used the real
    // clock, which timed out under full-suite load).
    await clock(h, Date.now() + HOUR);
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    for (let k = 0; k < 4 * FRAME_BUDGET.burst && !d.isClosed(); k++)
      d.send(junkAck());
    expect(await d.closed).toEqual({
      code: LIMITS.rateLimitCloseCode,
      reason: "rate limited",
    });
    expect(events(log, "bus_rate_limited")).toEqual([
      { evt: "bus_rate_limited", kind: "frames", machineId: m.id },
    ]);
  }, 120_000);

  /** Empties the socket's bucket on the hub side (the socket tagged `tag`). */
  const emptyBucket = (h: BusHubStub, tag: string, tokens = 0) =>
    inHub(h, (i, s) => {
      for (const ws of s.getWebSockets(tag))
        BusHub.setFrameTokensForTests(i, ws, tokens);
    });

  it("refills at 50 tokens per second", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    await emptyBucket(h, m.id, 1);
    d.send(hello("last"));
    await until(d, "hello_ok");
    await clock(h, t0 + 1000);
    acks(d, FRAME_BUDGET.refillPerSec - 1);
    d.send(hello("refilled"));
    await until(d, "hello_ok");
    expect(d.isClosed()).toBe(false);
    d.send(junkAck());
    expect((await d.closed).code).toBe(LIMITS.rateLimitCloseCode);
  });

  it("a bare ping is answered by the auto-response and never counts", async () => {
    const h = freshHub();
    await clock(h, Date.now() + HOUR);
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    await emptyBucket(h, m.id, 1);
    for (let k = 0; k < 100; k++) d.ws.send("ping");
    await tick(100);
    d.send(hello("last"));
    await until(d, "hello_ok");
    expect(d.isClosed()).toBe(false);
    d.send(junkAck());
    expect((await d.closed).code).toBe(LIMITS.rateLimitCloseCode);
  });
});

// ---------------------------------------------------------- live-agent caps

describe("live-agent caps", () => {
  it("pins the shared caps", () => {
    expect(LIMITS.maxAgentsPerMachine).toBe(200);
    expect(LIMITS.maxRosterAgents).toBe(1000);
  });

  it("per machine: agent_up past maxAgentsPerMachine gets rate_limited; the socket stays open", async () => {
    const log = vi.spyOn(console, "log");
    const h = freshHub();
    const n = ns("cap");
    const m = await machineOn(h);
    await seedAgents(h, m.id, LIMITS.maxAgentsPerMachine - 1, n);
    const d = await daemonOn(h, m.id);
    d.send(up("u1", "last", "Last", n));
    expect(await until(d, "agent_ok")).toMatchObject({ id: "u1" });
    d.send(up("u2", "over", "Over", n));
    const err = await until(d, "error");
    expect(err).toMatchObject({
      id: "u2",
      code: "rate_limited",
      message: "Too many live agents on this machine",
    });
    expect(err.message).toBe(AGENT_CAP_MESSAGES.machine);
    expect(
      await count(
        h,
        "select count(*) as n from agents where machine_id = ? and live = 1",
        m.id,
      ),
    ).toBe(LIMITS.maxAgentsPerMachine);
    // A re-up of an agent already live is not a new one: still accepted.
    d.send(up("u3", "last", "Last", n));
    expect(await until(d, "agent_ok")).toMatchObject({ id: "u3" });
    d.send(hello("still-open"));
    await until(d, "hello_ok");
    expect(d.isClosed()).toBe(false);
    expect(events(log, "bus_cap_refused")).toEqual([
      { evt: "bus_cap_refused", kind: "machine", machineId: m.id },
    ]);
  });

  it("per member: agent_up past maxRosterAgents live agents gets rate_limited", async () => {
    const log = vi.spyOn(console, "log");
    const h = freshHub();
    const n = ns("member");
    const per = LIMITS.maxAgentsPerMachine;
    for (let k = 0; k < LIMITS.maxRosterAgents / per; k++) {
      const other = await machineOn(h, `Other ${k}`);
      await seedAgents(h, other.id, per, n);
    }
    const m = await machineOn(h, "Mine");
    const d = await daemonOn(h, m.id);
    d.send(up("u1", "mine", "Mine", n));
    const orgErr = await until(d, "error");
    expect(orgErr).toMatchObject({
      id: "u1",
      code: "rate_limited",
      message: "Too many live agents on this bus",
    });
    expect(orgErr.message).toBe(AGENT_CAP_MESSAGES.member);
    expect(events(log, "bus_cap_refused")).toEqual([
      { evt: "bus_cap_refused", kind: "member", machineId: m.id },
    ]);
    d.send(hello("open"));
    await until(d, "hello_ok");
  });
});

// --------------------------------------------------------- bounded bulk work

/** A connected sender machine with one registered agent; returns its agent id. */
async function senderOn(h: BusHubStub, n: string) {
  const m = await machineOn(h, "Sender");
  const d = await daemonOn(h, m.id);
  d.send(up("su", "sender", "Sender", n));
  await until(d, "agent_ok");
  const id = await inHub(
    h,
    (_, s) =>
      s.storage.sql
        .exec<{ id: string }>(
          "select id from agents where machine_id = ? and native_ref = 'sender'",
          m.id,
        )
        .one().id,
  );
  return { d, id };
}

const agentIdOf = (h: BusHubStub, machineId: string, ref: string) =>
  inHub(
    h,
    (_, s) =>
      s.storage.sql
        .exec<{ id: string }>(
          "select id from agents where machine_id = ? and native_ref = ?",
          machineId,
          ref,
        )
        .one().id,
  );

const pendingCount = (h: BusHubStub) =>
  count(h, "select count(*) as n from receipts where state = 'pending'");

/** Runs the alarm by hand (the frozen clock is ahead, so it never fires itself). */
const alarmOnce = (h: BusHubStub) => runDurableObjectAlarm(stubOf(h));

/** Round-trips a hello so every frame sent before it has been handled. */
async function sync(d: D) {
  const id = `sync-${newId()}`;
  d.send(hello(id));
  for (;;) {
    const f = await d.next();
    if (f.type === "hello_ok" && f.id === id) return;
  }
}

describe("closed-session work drains from the alarm", () => {
  it("spends CLOSE_INLINE_BATCH (10) inline per frame", () => {
    expect(CLOSE_INLINE_BATCH).toBe(10);
  });

  it("sessions{closed} with 10,000 pending (#1295): nothing expires at the close; at +7 d the TTL sweep expires one batch per alarm run, every sender told once", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const n = ns("bulk");
    const s = await senderOn(h, n);
    const m = await machineOn(h);
    const ids = await seedAgents(h, m.id, LIMITS.maxAgentsPerMachine, n);
    const msgIds: string[] = [];
    for (const id of ids)
      msgIds.push(
        ...(await seedReceipts(h, id, LIMITS.inboxCap, {
          state: "pending",
          body: true,
          now: t0 - 10,
          from: s.id,
        })),
      );
    const total = msgIds.length;
    expect(total).toBe(10_000);
    const d = await daemonOn(h, m.id);
    const closed = Array.from({ length: LIMITS.maxRosterAgents }, (_, i) =>
      i < ids.length ? `seed_${i}` : `ghost_${i}`,
    );
    // Warm-up: the first large frame pays the decoder's JIT; the measured
    // frame below is the steady-state handler (ghost refs cost only decode).
    const g0 = performance.now();
    d.send({
      v: 1,
      id: "warm",
      type: "sessions",
      open: [],
      closed: closed.map((r) => `warm_${r}`),
    });
    await sync(d);
    console.info(
      `B11 measure: warm-up sessions{closed: ${closed.length} unknown refs} ${(performance.now() - g0).toFixed(1)} ms`,
    );
    const p0 = performance.now();
    d.send({ v: 1, id: "ss", type: "sessions", open: [], closed });
    await sync(d);
    console.info(
      `B11 measure: sessions{closed: ${closed.length} refs, ${ids.length} live, ${total} pending} handler round trip ${(performance.now() - p0).toFixed(1)} ms`,
    );
    expect(
      await count(
        h,
        "select count(*) as n from agents where machine_id = ? and live = 1",
        m.id,
      ),
    ).toBe(0);
    // The close keeps pending mail (and its bodies) for the away reservation.
    let left = await pendingCount(h);
    expect(left).toBe(total);
    expect(await count(h, "select count(*) as n from mail")).toBe(total);
    // The TTL sweep at +7 d, one batch per alarm run.
    await clock(h, t0 + MAILBOX_RETAIN_MS + 1000);
    let runs = 0;
    while (left > 0 && runs < 1000) {
      await alarmOnce(h);
      runs++;
      const now = await pendingCount(h);
      expect(left - now).toBeLessThanOrEqual(SWEEP_BATCH);
      left = now;
    }
    expect(left).toBe(0);
    expect(await count(h, "select count(*) as n from mail")).toBe(0);
    expect(
      await count(
        h,
        "select count(*) as n from receipts where state = 'expired' and reason is null and notified_at is not null",
      ),
    ).toBe(total);
    await sync(s.d);
    const told = new Map<string, number>();
    for (const f of s.d.seen)
      if (f.type === "receipt_update") {
        expect(f.state).toBe("expired");
        expect(f.reason).not.toBe("recipient_closed");
        told.set(f.msg_id, (told.get(f.msg_id) ?? 0) + 1);
      }
    expect(told.size).toBe(total);
    for (const id of msgIds) expect(told.get(id)).toBe(1);
  }, 120_000);

  it("a reopen with the same ref (#1295) gets the old pending mail and the new; the rest expires at +7 d, every sender told once", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const n = ns("reopen");
    const s = await senderOn(h, n);
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    d.send(up("u1", "victim", "Victim", n));
    await until(d, "agent_ok");
    const victim = await agentIdOf(h, m.id, "victim");
    const old = await seedReceipts(h, victim, 120, {
      state: "pending",
      body: true,
      now: t0 - 10,
      from: s.id,
    });
    // agent_down takes the same path as sessions{closed}: nothing expires.
    d.send({ v: 1, id: "dn", type: "agent_down", agent_ref: "victim" });
    await sync(d);
    expect(await pendingCount(h)).toBe(120);

    await clock(h, t0 + 10);
    d.seen.length = 0;
    d.send(up("u2", "victim", "Victim", n));
    await until(d, "agent_ok");
    await sync(d);
    const oldSet = new Set(old);
    // The reopen keeps the session boundary: the flush serves the oldest
    // batch of the old mail (one batch per agent_up).
    const flushed = d.seen.filter(
      (f) => f.type === "deliver" && oldSet.has(f.msg_id),
    );
    expect(flushed.length).toBeGreaterThanOrEqual(SWEEP_BATCH);
    for (const f of flushed)
      if (f.type === "deliver")
        d.send({ v: 1, id: `a-${f.msg_id}`, type: "ack", msg_id: f.msg_id });
    await sync(d);
    expect(
      await count(
        h,
        "select count(*) as n from receipts where state = 'delivered' and to_agent = ?",
        victim,
      ),
    ).toBe(flushed.length);

    s.d.send({
      v: 1,
      id: "fresh",
      type: "send",
      from_ref: "sender",
      to_name: "Victim",
      body: "new session",
    });
    const fresh = await until(s.d, "receipt");
    expect(fresh.state).toBe("pending");
    expect((await until(d, "deliver")).msg_id).toBe(fresh.msg_id);

    // At +7 d the unacked old mail expires; the fresh one (sent at t0 + 10)
    // is still pending until its own TTL, past this clock.
    await clock(h, t0 + MAILBOX_RETAIN_MS - 5);
    for (let k = 0; k < 20 && (await pendingCount(h)) > 1; k++)
      await alarmOnce(h);
    const unacked = old.length - flushed.length;
    expect(
      await count(
        h,
        "select count(*) as n from receipts where state = 'expired' and to_agent = ?",
        victim,
      ),
    ).toBe(unacked);
    expect(
      await count(
        h,
        "select count(*) as n from receipts where id = ? and state = 'pending'",
        fresh.msg_id,
      ),
    ).toBe(1);
    await sync(s.d);
    const told = s.d.seen.filter((f) => f.type === "receipt_update");
    const expiredTold = told.filter(
      (f) => f.type === "receipt_update" && f.state === "expired",
    );
    expect(expiredTold.length).toBe(unacked);
    expect(
      new Set(
        expiredTold.map((f) => (f.type === "receipt_update" ? f.msg_id : "")),
      ).size,
    ).toBe(unacked);
  }, 60_000);

  it("acked notices past one batch: the drain deletes the bodies; a reopened session fetches none (not_found)", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const n = ns("m1");
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    d.send(up("u1", "victim", "Victim", n));
    await until(d, "agent_ok");
    const victim = await agentIdOf(h, m.id, "victim");
    const extra = 10;
    const notices = await seedReceipts(h, victim, SWEEP_BATCH + extra, {
      state: "delivered",
      body: true,
      now: t0 - 10,
    });
    d.send({ v: 1, id: "dn", type: "agent_down", agent_ref: "victim" });
    await sync(d);
    const leftover = notices.length - CLOSE_INLINE_BATCH;
    expect(await count(h, "select count(*) as n from mail")).toBe(leftover);
    // The drain, one batch per alarm run, deletes the rest.
    for (let k = 0; k < 5; k++) await alarmOnce(h);
    expect(await count(h, "select count(*) as n from mail")).toBe(0);

    await clock(h, t0 + 10);
    d.send(up("u2", "victim", "Victim", n));
    await until(d, "agent_ok");
    for (const id of notices) {
      d.send({
        v: 1,
        id: `f-${id}`,
        type: "fetch",
        from_ref: "victim",
        msg_id: id,
      });
      expect(await until(d, "error")).toMatchObject({
        id: `f-${id}`,
        code: "not_found",
      });
    }
  });
});

describe("revoke drain (B9) is persisted", () => {
  const pendingRevoked = (h: BusHubStub) =>
    count(
      h,
      "select count(*) as n from receipts where state = 'expired' and reason = 'revoked'",
    );
  const pending = (h: BusHubStub) =>
    count(h, "select count(*) as n from receipts where state = 'pending'");

  it("an eviction mid-drain still finishes: a rehydrated hub's alarm drains the rest as revoked", async () => {
    const log = vi.spyOn(console, "log");
    const h = freshHub();
    // The hub clock an hour ahead (as hub.events and hub.revoke do): the
    // alarm revokeMachine arms at now + 1 lies in the wall-clock future, so
    // the real alarm cannot drain past the first batch before it is read.
    const now = Date.now() + HOUR;
    await clock(h, now);
    const n = ns("evict");
    const m = await machineOn(h);
    const agents = await seedAgents(h, m.id, 3, n);
    for (const a of agents)
      await seedReceipts(h, a, 30, { state: "pending", body: true, now });
    expect(await h.revokeMachine(m.id)).toBe(true);
    expect(await pendingRevoked(h)).toBe(SWEEP_BATCH);
    // Simulated eviction: a brand-new BusHub on the same state, then its alarm.
    const left = await inHub(h, async (_, s) => {
      const fresh = new BusHub(s, e);
      for (let k = 0; k < 5; k++) await fresh.alarm();
      return s.storage.sql
        .exec<{ n: number }>(
          "select count(*) as n from receipts where state = 'pending'",
        )
        .one().n;
    });
    expect(left).toBe(0);
    expect(await pendingRevoked(h)).toBe(90);
    expect(await count(h, "select count(*) as n from mail")).toBe(0);
    expect(events(log, "bus_machine_revoked")).toEqual([
      { evt: "bus_machine_revoked", machineId: m.id },
    ]);
  });

  it("has no 1000-agent ceiling", async () => {
    const h = freshHub();
    const now = Date.now() + HOUR;
    await clock(h, now);
    const n = ns("many");
    const m = await machineOn(h);
    const agents = await seedAgents(h, m.id, LIMITS.maxRosterAgents + 5, n);
    // One pending receipt each, for the last few agents past the old ceiling.
    for (const a of agents.slice(-10))
      await seedReceipts(h, a, 1, { state: "pending", body: true, now });
    expect(await h.revokeMachine(m.id)).toBe(true);
    await drain(h, async () => (await pending(h)) === 0);
    expect(await pending(h)).toBe(0);
    expect(await pendingRevoked(h)).toBe(10);
    // The persisted queue is empty once drained.
    expect(
      await count(
        h,
        "select count(*) as n from meta where key like 'revoke_drain:%'",
      ),
    ).toBe(0);
  });

  it("drops revoked agents' acked-unfetched notice bodies past one batch", async () => {
    const h = freshHub();
    const now = Date.now() + HOUR;
    await clock(h, now);
    const n = ns("bodies");
    const m = await machineOn(h);
    const [a] = await seedAgents(h, m.id, 1, n);
    await seedReceipts(h, a as string, SWEEP_BATCH * 2 + 3, {
      state: "delivered",
      body: true,
      now,
    });
    expect(await h.revokeMachine(m.id)).toBe(true);
    await drain(
      h,
      async () => (await count(h, "select count(*) as n from mail")) === 0,
    );
    expect(await count(h, "select count(*) as n from mail")).toBe(0);
  });
});

// ------------------------------------------------------------------- logs

describe("hub logs", () => {
  it("hub_reject carries the code and machine id, and no log line carries a token", async () => {
    const log = vi.spyOn(console, "log");
    const h = freshHub();
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    d.ws.send("{not json");
    await until(d, "error");
    d.send({
      v: 1,
      id: "l1",
      type: "list",
      from_ref: "nobody",
    } as ClientFrame);
    await until(d, "error");
    expect(events(log, "bus_hub_reject")).toEqual([
      { evt: "bus_hub_reject", code: "bad_frame", machineId: m.id },
      { evt: "bus_hub_reject", code: "not_registered", machineId: m.id },
    ]);
    await h.revokeMachine(m.id);
    const all = JSON.stringify(log.mock.calls);
    expect(all).not.toMatch(/oa_machine_/);
  });
});
