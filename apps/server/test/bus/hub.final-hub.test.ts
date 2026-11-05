// Ported from OpenBus v0.63.0 apps/server/test/hub.final-hub.test.ts (#1291).
// Dropped: nothing (machines are seeded as the hub's mirror row; the dashboard
// check in L1 reads snapshot() instead of listAgents(namespace)).
// Final whole-track review, hub area (final/hub-report.md): M1 closed-agent
// purge and per-machine cap, M2 indexed revoke drain, L1 roster liveness.
// Every test runs on its own hub (newUniqueId).
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  AGENT_CAP_MESSAGES,
  type ClientFrame,
  decodeServerFrame,
  encodeFrame,
  MAILBOX_RETAIN_MS,
  newId,
  PONG,
  type ServerFrame,
} from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import {
  AUTHZ_AT_HEADER,
  BusHub,
  CLOSED_AGENT_RETAIN_MS,
  CLOSED_AGENTS_PER_MACHINE,
  CONNECT_DO_PATH,
  MACHINE_ID_HEADER,
  MACHINE_LABEL_HEADER,
  OWNER_ORG_ID,
  SEND_KEY_RETAIN_MS,
  SWEEP_BATCH,
} from "../../src/bus/hub.js";
import { e, ns, up } from "./helpers.js";

type BusHubStub = DurableObjectStub<BusHub>;
const busNs = () => e.BUS_HUB as DurableObjectNamespace<BusHub>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const freshHub = (): BusHubStub => busNs().get(busNs().newUniqueId());
const stubOf = (h: BusHubStub) => h;
const inHub = <R>(h: BusHubStub, fn: (i: BusHub, s: DurableObjectState) => R) =>
  runInDurableObject(stubOf(h), (i: BusHub, s) => fn(i, s));
const clock = (h: BusHubStub, ms: number | null) =>
  inHub(h, (i) => BusHub.setTestClock(i, ms));
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (h: BusHubStub, q: string, ...b: SqlStorageValue[]) =>
  inHub(h, (_, s) => s.storage.sql.exec<{ n: number }>(q, ...b).one().n);

/** A machine on `h`: the hub's mirror row (the D1 row is the Worker's). */
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

/** Seeds `n` agents on a machine straight into SQL (live or closed). */
const seedAgents = (
  h: BusHubStub,
  machineId: string,
  n: number,
  namespace: string,
  live: 0 | 1,
  updatedAt: number,
) =>
  inHub(h, (_, s) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = newId();
      ids.push(id);
      s.storage.sql.exec(
        `insert into agents (id, org_id, namespace, name, kind, machine_id, native_ref, global, live, updated_at)
         values (?, ?, ?, ?, 'claude-code', ?, ?, 0, ?, ?)`,
        id,
        OWNER_ORG_ID,
        namespace,
        `seed-${live}-${i}`,
        machineId,
        `seed_${live}_${i}`,
        live,
        updatedAt,
      );
    }
    return ids;
  });

type D = {
  ws: WebSocket;
  send: (f: ClientFrame) => void;
  next: () => Promise<ServerFrame>;
};
async function daemonOn(h: BusHubStub, machineId: string): Promise<D> {
  const res = await stubOf(h).fetch(`https://hub.internal${CONNECT_DO_PATH}`, {
    headers: {
      Upgrade: "websocket",
      [MACHINE_ID_HEADER]: machineId,
      [MACHINE_LABEL_HEADER]: "MacBook",
      [AUTHZ_AT_HEADER]: String(Date.now()),
    },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  const q: ServerFrame[] = [];
  const w: ((f: ServerFrame) => void)[] = [];
  ws.addEventListener("message", (ev) => {
    const t = String(ev.data);
    if (t === PONG) return;
    const r = decodeServerFrame(t);
    if (!r.ok) return;
    const k = w.shift();
    if (k) k(r.frame);
    else q.push(r.frame);
  });
  return {
    ws,
    send: (f) => ws.send(encodeFrame(f)),
    next: () => {
      const f = q.shift();
      return f ? Promise.resolve(f) : new Promise((r) => w.push(r));
    },
  };
}

async function until<T extends ServerFrame["type"]>(d: D, type: T) {
  for (let i = 0; i < 5000; i++) {
    const f = await d.next();
    if (f.type === type) return f as Extract<ServerFrame, { type: T }>;
  }
  throw new Error(`no ${type}`);
}

const agents = (h: BusHubStub, machineId: string) =>
  count(h, "select count(*) as n from agents where machine_id = ?", machineId);
const exists = async (h: BusHubStub, id: string) =>
  (await count(h, "select count(*) as n from agents where id = ?", id)) === 1;

/** Runs the alarm a few times (each run is one bounded step of every queue). */
async function alarms(h: BusHubStub, n = 5) {
  for (let k = 0; k < n; k++) {
    await runDurableObjectAlarm(stubOf(h));
    await tick(2);
  }
}

// ------------------------------------------------------------------- M1

describe("M1: closed agents are purged once idle, and capped per machine", () => {
  it("ref churn past CLOSED_AGENTS_PER_MACHINE leaves at most the cap (oldest idle closed rows purged inline)", async () => {
    const h = freshHub();
    const now = Date.now() + HOUR;
    await clock(h, now);
    const m = await machineOn(h);
    const n = ns("churn");
    // The machine already holds the cap in closed rows (recent, idle).
    const old = await seedAgents(
      h,
      m.id,
      CLOSED_AGENTS_PER_MACHINE,
      n,
      0,
      now - 1000,
    );
    const d = await daemonOn(h, m.id);
    const CYCLES = 50;
    for (let i = 0; i < CYCLES; i++) {
      d.send(up(`u${i}`, `ref_${i}`, "Churn", n));
      d.send({ v: 1, id: `d${i}`, type: "agent_down", agent_ref: `ref_${i}` });
    }
    for (let k = 0; k < CYCLES; ) {
      const f = await d.next();
      expect(f.type).not.toBe("error");
      if (f.type === "agent_ok") k++;
    }
    await tick(50);
    expect(
      await count(h, "select count(*) as n from agents where live = 1"),
    ).toBe(0);
    expect(await agents(h, m.id)).toBeLessThanOrEqual(
      CLOSED_AGENTS_PER_MACHINE,
    );
    // The oldest were the ones purged.
    expect(await exists(h, old[0] as string)).toBe(false);
    expect(await exists(h, old.at(-1) as string)).toBe(true);
  });

  it("at the cap with no idle closed agent to purge, a new agent_up is refused rate_limited; a known ref still re-ups", async () => {
    const h = freshHub();
    const now = Date.now() + HOUR;
    await clock(h, now);
    const m = await machineOn(h);
    const n = ns("busy");
    const ids = await seedAgents(
      h,
      m.id,
      CLOSED_AGENTS_PER_MACHINE,
      n,
      0,
      now - 1000,
    );
    // Every closed agent still has a send key within retention.
    await inHub(h, (_, s) => {
      for (const id of ids)
        s.storage.sql.exec(
          `insert into send_keys (from_agent, frame_id, org_id, payload_hash, msg_id, created_at, final)
           values (?, ?, ?, 'h', 'm', ?, 1)`,
          id,
          newId(),
          OWNER_ORG_ID,
          now - 1000,
        );
    });
    const d = await daemonOn(h, m.id);
    d.send(up("u1", "ref_new", "Fresh", n));
    const err = await until(d, "error");
    expect(err).toMatchObject({
      id: "u1",
      code: "rate_limited",
      message: AGENT_CAP_MESSAGES.machine,
    });
    expect(await agents(h, m.id)).toBe(CLOSED_AGENTS_PER_MACHINE);
    // A closed agent coming back adds no row: never refused by this cap.
    d.send(up("u2", "seed_0_0", "Back", n));
    expect(await until(d, "agent_ok")).toMatchObject({ id: "u2" });
  });

  it("R1: at the cap, an idle closed agent past the 50 oldest is found; the agent_up succeeds", async () => {
    const h = freshHub();
    const now = Date.now() + HOUR;
    await clock(h, now);
    const m = await machineOn(h);
    const n = ns("r1");
    const ids = await seedAgents(
      h,
      m.id,
      CLOSED_AGENTS_PER_MACHINE,
      n,
      0,
      now - 10_000,
    );
    // The 50 oldest (same updated_at: rowid order) each have an untold final receipt.
    const busy = ids.slice(0, 50);
    await inHub(h, (_, s) => {
      for (const id of busy)
        s.storage.sql.exec(
          `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at, final_at, acked_at)
           values (?, ?, 'seed', 'x', 'to', ?, 'from', 'delivered', 1, ?, ?, ?, ?)`,
          newId(),
          OWNER_ORG_ID,
          id,
          now - 5000,
          now + HOUR,
          now - 1000,
          now - 1000,
        );
    });
    const d = await daemonOn(h, m.id);
    d.send(up("u", "fresh_ref", "Fresh", n));
    expect(await d.next()).toMatchObject({ type: "agent_ok", id: "u" });
    for (const id of busy) expect(await exists(h, id)).toBe(true);
    expect(await exists(h, ids[50] as string)).toBe(false);
  });

  it("R1: worst case, 1000 closed agents all with work: the full search refuses (timed)", async () => {
    const h = freshHub();
    const now = Date.now() + HOUR;
    await clock(h, now);
    const m = await machineOn(h);
    const ids = await seedAgents(
      h,
      m.id,
      CLOSED_AGENTS_PER_MACHINE,
      ns("r1w"),
      0,
      now - 10_000,
    );
    await inHub(h, (_, s) => {
      for (const id of ids)
        s.storage.sql.exec(
          `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at, final_at, acked_at)
           values (?, ?, 'seed', 'x', 'to', ?, 'from', 'delivered', 1, ?, ?, ?, ?)`,
          newId(),
          OWNER_ORG_ID,
          id,
          now - 5000,
          now + HOUR,
          now - 1000,
          now - 1000,
        );
      s.storage.sql.exec("select count(*) from agents").toArray(); // warm
    });
    const samples: number[] = [];
    for (let k = 0; k < 5; k++)
      samples.push(
        await inHub(h, (i) => {
          const t = performance.now();
          const ok = BusHub.roomForClosedForTests(i, m.id, `fresh_${k}`);
          const ms = performance.now() - t;
          expect(ok).toBe(false);
          return ms;
        }),
      );
    samples.sort((a, b) => a - b);
    console.log(
      `R1 worst case (${CLOSED_AGENTS_PER_MACHINE} closed, none idle), #roomForClosed: ${samples.join(", ")} ms`,
    );
    expect(await agents(h, m.id)).toBe(CLOSED_AGENTS_PER_MACHINE);
  });

  it("the alarm purges an idle closed agent 24 h after it closed, not before", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    const n = ns("idle24");
    d.send(up("u1", "ref_a", "Idle", n));
    await until(d, "agent_ok");
    d.send({ v: 1, id: "d1", type: "agent_down", agent_ref: "ref_a" });
    await tick(30);
    const id = (
      await inHub(h, (_, s) =>
        s.storage.sql
          .exec<{ id: string }>(
            "select id from agents where native_ref = 'ref_a'",
          )
          .one(),
      )
    ).id;
    // The alarm is armed for the purge.
    const armed = await inHub(h, (_, s) => s.storage.getAlarm());
    expect(armed).not.toBeNull();
    expect(armed as number).toBeLessThanOrEqual(
      t0 + CLOSED_AGENT_RETAIN_MS + 1,
    );
    await clock(h, t0 + CLOSED_AGENT_RETAIN_MS - 1);
    await alarms(h, 2);
    expect(await exists(h, id)).toBe(true);
    // #1295: the away reservation keeps the row past 24 h.
    await clock(h, t0 + CLOSED_AGENT_RETAIN_MS + 1);
    await alarms(h, 2);
    expect(await exists(h, id)).toBe(true);
    await clock(h, t0 + MAILBOX_RETAIN_MS + 1);
    await alarms(h, 2);
    expect(await exists(h, id)).toBe(false);
    // The ref comes back with a new id: a purged id is never reused.
    d.send(up("u2", "ref_a", "Idle", n));
    await until(d, "agent_ok");
    const again = await inHub(h, (_, s) =>
      s.storage.sql
        .exec<{ id: string }>(
          "select id from agents where native_ref = 'ref_a'",
        )
        .one(),
    );
    expect(again.id).not.toBe(id);
  });

  it("a closed agent that still has work is kept (each kind of work), past 24 h", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    const late = t0 + DAY + HOUR;
    await clock(h, late);
    const m = await machineOn(h);
    const n = ns("work");
    const [pendTo, pendFrom, mailTo, key, untold, idle] = (await seedAgents(
      h,
      m.id,
      6,
      n,
      0,
      t0 - DAY,
    )) as [string, string, string, string, string, string];
    await inHub(h, (_, s) => {
      const sql = s.storage.sql;
      const rec = (
        to: string,
        from: string,
        state: string,
        notified: number | null,
      ) =>
        sql.exec(
          `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at, notified_at, final_at)
           values (?, ?, 'seed', ?, 'to', ?, 'from', ?, 1, ?, ?, ?, ?)`,
          newId(),
          OWNER_ORG_ID,
          to,
          from,
          state,
          late,
          late + HOUR,
          notified,
          state === "pending" ? null : late,
        );
      rec(pendTo, "nobody", "pending", null);
      rec("nobody", pendFrom, "pending", null);
      rec("nobody", untold, "delivered", null);
      sql.exec(
        "insert into mail (id, org_id, to_agent, body, created_at, expires_at) values (?, ?, ?, 'b', ?, ?)",
        newId(),
        OWNER_ORG_ID,
        mailTo,
        late,
        late + HOUR,
      );
      sql.exec(
        `insert into send_keys (from_agent, frame_id, org_id, payload_hash, msg_id, created_at, final)
         values (?, ?, ?, 'h', 'm', ?, 1)`,
        key,
        newId(),
        OWNER_ORG_ID,
        late - SEND_KEY_RETAIN_MS + HOUR,
      );
    });
    // Seeded straight into SQL: nothing armed, so the alarm runs by hand.
    for (let k = 0; k < 3; k++) await inHub(h, (i) => i.alarm());
    for (const id of [pendTo, pendFrom, mailTo, key, untold])
      expect(await exists(h, id), id).toBe(true);
    expect(await exists(h, idle)).toBe(false);
  });

  it("purges in bounded steps through an index", async () => {
    const h = freshHub();
    const now = Date.now() + HOUR;
    await clock(h, now);
    const m = await machineOn(h);
    await seedAgents(h, m.id, 130, ns("batch"), 0, now - DAY - 1);
    const plan = await inHub(h, (_, s) =>
      s.storage.sql
        .exec<{ detail: string }>(
          `explain query plan select rowid, id, updated_at from agents indexed by agents_closed
            where live = 0 and updated_at < ? order by updated_at, rowid limit 50`,
          now,
        )
        .toArray()
        .map((r) => r.detail)
        .join("\n"),
    );
    console.log(`closed-agent purge plan:\n${plan}`);
    expect(plan).toContain("agents_closed");
    expect(plan).not.toMatch(/SCAN agents(?! USING)/);
    const ms = await inHub(h, async (i) => {
      const t = performance.now();
      await i.alarm();
      return performance.now() - t;
    });
    console.log(
      `one alarm step purging ${SWEEP_BATCH} closed agents: ${ms} ms`,
    );
    expect(await agents(h, m.id)).toBe(80);
    await alarms(h, 3);
    expect(await agents(h, m.id)).toBe(0);
  });
});

// ------------------------------------------------------------------- M2

describe("M2: the revoke drain is driven from agents with work, not agent history", () => {
  // Closed recently (updated_at = now), so the M1 purge leaves them alone
  // and the timings below are the revoke drain's alone.
  const seedIdle = (
    h: BusHubStub,
    machineId: string,
    n: number,
    nsp: string,
    now: number,
  ) =>
    inHub(h, (_, s) => {
      s.storage.sql.exec(
        `with recursive c(i) as (select 1 union all select i + 1 from c where i < ?)
         insert into agents (id, org_id, namespace, name, kind, machine_id, native_ref, global, live, updated_at)
         select lower(hex(randomblob(16))), ?, ?, 'idle-' || i, 'claude-code', ?, 'idle_' || i, 0, 0, ? from c`,
        n,
        OWNER_ORG_ID,
        nsp,
        machineId,
        now,
      );
    });
  const seedPending = (
    h: BusHubStub,
    toAgent: string,
    n: number,
    now: number,
  ) =>
    inHub(h, (_, s) => {
      for (let i = 0; i < n; i++) {
        const id = newId();
        s.storage.sql.exec(
          `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at)
           values (?, ?, 'seed', ?, 'to', 'nobody', 'from', 'pending', 1, ?, ?)`,
          id,
          OWNER_ORG_ID,
          toAgent,
          now,
          now + HOUR,
        );
        s.storage.sql.exec(
          "insert into mail (id, org_id, to_agent, body, created_at, expires_at) values (?, ?, ?, 'b', ?, ?)",
          id,
          OWNER_ORG_ID,
          toAgent,
          now,
          now + HOUR,
        );
      }
    });
  const timeRevoke = (h: BusHubStub, id: string) =>
    inHub(h, async (i) => {
      const t = performance.now();
      await i.revokeMachine(id);
      return performance.now() - t;
    });
  const revoked = (h: BusHubStub) =>
    count(
      h,
      "select count(*) as n from receipts where state = 'expired' and reason = 'revoked'",
    );

  it("with 200k idle closed agents, revokeMachine (and each drain step) stays near its no-history cost", async () => {
    const IDLE = 200_000;
    const run = async (idle: number) => {
      const h = freshHub();
      const now = Date.now() + HOUR;
      await clock(h, now);
      const m = await machineOn(h);
      const nsp = ns("idle");
      if (idle > 0) await seedIdle(h, m.id, idle, nsp, now);
      const live = await seedAgents(h, m.id, 3, nsp, 1, now);
      for (const a of live) await seedPending(h, a, 30, now);
      const ms = await timeRevoke(h, m.id);
      const step = await inHub(h, async (i) => {
        const t = performance.now();
        await i.alarm();
        return performance.now() - t;
      });
      expect(await revoked(h)).toBe(90);
      return { ms, step };
    };
    // The best of two runs each: one sample on a loaded runner is noise.
    const best = async (idle: number) => {
      const [a, b] = [await run(idle), await run(idle)];
      return { ms: Math.min(a.ms, b.ms), step: Math.min(a.step, b.step) };
    };
    const base = await best(0);
    const big = await best(IDLE);
    console.log(
      `revokeMachine: no history ${base.ms.toFixed(2)} ms, ${IDLE} idle closed ${big.ms.toFixed(2)} ms; alarm step ${base.step.toFixed(2)} vs ${big.step.toFixed(2)} ms`,
    );
    expect(big.ms).toBeLessThan(base.ms + 10);
    expect(big.step).toBeLessThan(base.step + 10);
  }, 120_000);

  it("the drain's queries use indexes (EXPLAIN QUERY PLAN)", async () => {
    const h = freshHub();
    const plans = await inHub(h, (_, s) => {
      const plan = (q: string, ...b: SqlStorageValue[]) =>
        s.storage.sql
          .exec<{ detail: string }>(`explain query plan ${q}`, ...b)
          .toArray()
          .map((r) => r.detail)
          .join("; ");
      return {
        snapshot: plan(
          "select id from agents where machine_id = ? and live = 1 order by rowid",
          "m",
        ),
        pending: plan(
          "select id, from_agent as fromAgent from receipts where to_agent = ? and state = 'pending' limit ?",
          "a",
          50,
        ),
      };
    });
    console.log(`revoke drain plans: ${JSON.stringify(plans)}`);
    expect(plans.snapshot).toMatch(/agents_machine|agents_live/);
    expect(plans.pending).toContain("receipts_to");
  });

  it("an idle closed history does not delay a live agent's drain (one step reaches it)", async () => {
    const h = freshHub();
    const now = Date.now() + HOUR;
    await clock(h, now);
    const m = await machineOn(h);
    const nsp = ns("order");
    await seedIdle(h, m.id, 5000, nsp, now);
    const [a] = await seedAgents(h, m.id, 1, nsp, 1, now);
    await seedPending(h, a as string, 3, now);
    expect(await h.revokeMachine(m.id)).toBe(true);
    expect(await revoked(h)).toBe(3);
    expect(
      await count(
        h,
        "select count(*) as n from meta where key like 'revoke_drain:%'",
      ),
    ).toBe(0);
  });
});

// ------------------------------------------------------------------- L1

describe("L1: roster state counts only open, current sockets", () => {
  it("an agent whose machine's only socket is replaced (not yet closed) lists as queued", async () => {
    const h = freshHub();
    const n = ns("l1");
    const ma = await machineOn(h);
    const mb = await machineOn(h);
    const a = await daemonOn(h, ma.id);
    const b = await daemonOn(h, mb.id);
    a.send(up("ua", "ref_a", "Alpha", n));
    await until(a, "agent_ok");
    b.send(up("ub", "ref_b", "Bravo", n));
    await until(b, "agent_ok");
    // A's socket is marked replaced (as a takeover does before the close lands).
    await inHub(h, (_, s) => {
      for (const ws of s.getWebSockets(ma.id))
        ws.serializeAttachment({ machineId: ma.id, replaced: true });
    });
    b.send({ v: 1, id: "l1", type: "list", from_ref: "ref_b" });
    const r = await until(b, "roster");
    const alpha = r.agents.find((x) => x.bus_name === "Alpha");
    expect(alpha?.state).toBe("queued");
    // The dashboard agrees.
    const listed = (await h.snapshot()).agents.filter((x) => x.namespace === n);
    expect(listed.find((x) => x.name === "Alpha")?.state).toBe("queued");
  });
});
