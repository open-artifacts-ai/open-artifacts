// Ported from OpenBus apps/server/test/hub.offline-reap.test.ts (open-bus #442).
// Dropped: nothing. Added: wipe keeps the column, and closeAll's kinds (#1350).
// A machine offline for over OFFLINE_REAP_MS (24 h) has its live agents
// closed by the alarm, exactly as agent_down closes one. machines
// .disconnected_at records when its last socket went; a connect clears it; a
// replaced socket never sets it. A hub that predates the column (an offline
// machine with live agents and no disconnected_at) starts counting at its
// next wake, so a deploy never reaps at once. Time is BusHub.setTestClock,
// always set ahead of real time and reset after each test.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  BUS_CAPS,
  type ClientFrame,
  type ServerFrame,
} from "@oa/bus-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BusHub, OFFLINE_REAP_MS, SWEEP_BATCH } from "../../src/bus/hub.js";
import { busCloseKind } from "../../src/services/bus.js";
import {
  type Daemon,
  daemon,
  e,
  hello,
  hubOf,
  machine,
  member,
  ns,
  up,
  waitFor,
} from "./helpers.js";

const inHub = async <R>(
  fn: (i: BusHub, s: DurableObjectState) => R,
  userId?: string,
) => runInDurableObject(await hubOf(userId), fn);
const setClock = (ms: number | null, userId?: string) =>
  inHub((i) => BusHub.setTestClock(i, ms), userId);
const runAlarm = async (userId?: string) =>
  runDurableObjectAlarm(await hubOf(userId));
const alarmAt = () => inHub((_, s) => s.storage.getAlarm());

afterEach(async () => {
  await setClock(null);
});

let seq = 0;
const id = (t: string) => `${t}${++seq}`;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;
/** A frozen hub time ahead of real time, distinct per test. */
const base = () => Date.now() + 3_600_000 + ++seq * 1000;

type Roster = Extract<ServerFrame, { type: "roster" }>;
type Receipt = Extract<ServerFrame, { type: "receipt" }>;

async function connect(token: string, renames = false): Promise<Daemon> {
  const d = await daemon(token);
  d.send(
    renames
      ? { ...hello(id("h")), caps: [BUS_CAPS.rename] }
      : hello(id("h")),
  );
  await waitFor(d, "hello_ok");
  return d;
}

async function reg(
  d: Daemon,
  ref: string,
  name: string,
  namespace: string,
): Promise<string> {
  d.send(up(id("u"), ref, name, namespace));
  return (await waitFor(d, "agent_ok")).bus_name;
}

async function list(d: Daemon, from: string): Promise<Roster> {
  const fid = id("l");
  d.send({ v: 1, id: fid, type: "list", from_ref: from });
  for (;;) {
    const f = await d.next();
    if (f.type === "roster" && f.id === fid) return f;
  }
}

async function send(d: Daemon, from: string, to: string): Promise<Receipt> {
  const fid = id("s");
  d.send({
    v: 1,
    id: fid,
    type: "send",
    from_ref: from,
    to_name: to,
    body: "hi",
  } as ClientFrame);
  for (;;) {
    const f = await d.next();
    if (f.type === "receipt" && f.id === fid) return f;
  }
}

const stateOf = (r: Roster, name: string) =>
  r.agents.find((a) => a.bus_name === name)?.state;

const disconnectedAt = (machineId: string, userId?: string) =>
  inHub((_, s) => {
    const r = s.storage.sql
      .exec("select disconnected_at as t from machines where id = ?", machineId)
      .toArray()[0];
    return r === undefined ? undefined : (r.t as number | null);
  }, userId);

const liveOf = (machineId: string, userId?: string) =>
  inHub(
    (_, s) =>
      s.storage.sql
        .exec(
          "select name from agents where machine_id = ? and live = 1 order by name",
          machineId,
        )
        .toArray()
        .map((r) => String(r.name)),
    userId,
  );

/** Closes the daemon and waits until the hub has recorded the machine offline. */
async function goOffline(
  d: Daemon,
  machineId: string,
  userId?: string,
): Promise<number> {
  d.close();
  await d.closed;
  for (let k = 0; k < 200; k++) {
    const t = await disconnectedAt(machineId, userId);
    if (typeof t === "number") return t;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("machine never recorded offline");
}

/** Runs the alarm at hub time `t` (armed first, so it always runs). */
async function alarmAtTime(t: number, userId?: string): Promise<void> {
  await setClock(t, userId);
  await inHub(async (_, s) => {
    if ((await s.storage.getAlarm()) === null) await s.storage.setAlarm(t);
  }, userId);
  await runAlarm(userId);
}

describe("offline reap (open-bus #422)", () => {
  it("closes a machine's agents after 24 h offline, not before; others untouched", async () => {
    const t0 = base();
    await setClock(t0);
    const away = await machine("Away");
    const watch = await machine("Watch");
    const other = await machine("Other");
    const n = ns("reap");
    const n2 = ns("reap2");
    const a = await connect(away.token);
    const w = await connect(watch.token);
    const o = await connect(other.token);
    const gone = await reg(a, "ga", uniq("Gone"), n);
    await reg(w, "wa", uniq("Watch"), n);
    const stay = await reg(o, "oa", uniq("Stay"), n2);

    expect(await disconnectedAt(away.id)).toBeNull();
    expect(await goOffline(a, away.id)).toBe(t0);
    // Another machine offline, but only for an hour at the reap time.
    await setClock(t0 + OFFLINE_REAP_MS - 3_600_000);
    await goOffline(o, other.id);

    // The reap deadline is armed.
    const at = await alarmAt();
    expect(at).not.toBeNull();
    expect(at as number).toBeLessThanOrEqual(t0 + OFFLINE_REAP_MS);

    await alarmAtTime(t0 + OFFLINE_REAP_MS - 1);
    expect(stateOf(await list(w, "wa"), gone)).toBe("queued");
    expect(await liveOf(away.id)).toEqual([gone]);

    await alarmAtTime(t0 + OFFLINE_REAP_MS);
    expect(await liveOf(away.id)).toEqual([]);
    expect(stateOf(await list(w, "wa"), gone)).toBeUndefined();
    expect(await send(w, "wa", gone)).toMatchObject({
      state: "refused",
      reason: "closed",
    });
    // The other offline machine's agent is still open (queued).
    expect(await liveOf(other.id)).toEqual([stay]);
    expect(await disconnectedAt(other.id)).toBe(
      t0 + OFFLINE_REAP_MS - 3_600_000,
    );
    // No hot loop: nothing re-arms at now + 1 for the reaped machine.
    const next = await alarmAt();
    expect(next === null || next > t0 + OFFLINE_REAP_MS + 1).toBe(true);
    w.close();
  });

  it("a machine that reconnects before 24 h is not reaped", async () => {
    const t0 = base();
    await setClock(t0);
    const m = await machine("Back");
    const n = ns("back");
    const d = await connect(m.token);
    const name = await reg(d, "b", uniq("Back"), n);
    await goOffline(d, m.id);
    await setClock(t0 + 3_600_000);
    const d2 = await connect(m.token);
    expect(await disconnectedAt(m.id)).toBeNull();
    await alarmAtTime(t0 + 2 * OFFLINE_REAP_MS);
    expect(await liveOf(m.id)).toEqual([name]);
    expect(stateOf(await list(d2, "b"), name)).toBe("live");
    d2.close();
  });

  it("a replaced socket never marks the machine offline", async () => {
    const t0 = base();
    await setClock(t0);
    const m = await machine("Twice");
    const d1 = await connect(m.token);
    const name = await reg(d1, "t", uniq("Twice"), ns("twice"));
    const d2 = await connect(m.token);
    const c = await d1.closed;
    expect(c.reason).toBe("replaced");
    await new Promise((r) => setTimeout(r, 20));
    expect(await disconnectedAt(m.id)).toBeNull();
    await alarmAtTime(t0 + 2 * OFFLINE_REAP_MS);
    expect(await liveOf(m.id)).toEqual([name]);
    d2.close();
  });

  it("a reaped agent comes back live, with its name, when the daemon re-announces it", async () => {
    const t0 = base();
    await setClock(t0);
    const m = await machine("Return");
    const n = ns("ret");
    const d = await connect(m.token);
    const name = await reg(d, "r", uniq("Return"), n);
    await goOffline(d, m.id);
    await alarmAtTime(t0 + OFFLINE_REAP_MS);
    expect(await liveOf(m.id)).toEqual([]);

    await setClock(t0 + OFFLINE_REAP_MS + 60_000);
    const d2 = await connect(m.token);
    expect(await disconnectedAt(m.id)).toBeNull();
    expect(await reg(d2, "r", name, n)).toBe(name);
    expect(stateOf(await list(d2, "r"), name)).toBe("live");
    d2.close();
  });

  it("drops a reaped agent's former names and rename log", async () => {
    const t0 = base();
    await setClock(t0);
    const m = await machine("Renamed");
    const n = ns("fn");
    const d = await connect(m.token, true);
    const old = uniq("Old");
    await reg(d, "f", old, n);
    const fid = id("r");
    const now = uniq("New");
    d.send({
      v: 1,
      id: fid,
      type: "rename",
      agent_ref: "f",
      proposed_name: now,
    });
    expect((await waitFor(d, "renamed")).bus_name).toBe(now);
    const agentId = await inHub(
      (_, s) =>
        s.storage.sql
          .exec("select id from agents where name = ?", now)
          .toArray()[0]?.id as string,
    );
    // Kept past the reap, so only the close can drop them.
    await inHub((_, s) => {
      s.storage.sql.exec(
        "update former_names set expires_at = ? where agent_id = ?",
        t0 + 10 * OFFLINE_REAP_MS,
        agentId,
      );
      s.storage.sql.exec(
        "update rename_rl set at = ? where agent_id = ?",
        t0 + 10 * OFFLINE_REAP_MS,
        agentId,
      );
    });
    const count = (table: string) =>
      inHub(
        (_, s) =>
          s.storage.sql
            .exec(
              `select count(*) as n from ${table} where agent_id = ?`,
              agentId,
            )
            .toArray()[0]?.n as number,
      );
    expect(await count("former_names")).toBe(1);
    expect(await count("rename_rl")).toBeGreaterThan(0);
    await goOffline(d, m.id);
    await alarmAtTime(t0 + OFFLINE_REAP_MS);
    expect(await liveOf(m.id)).toEqual([]);
    expect(await count("former_names")).toBe(0);
    expect(await count("rename_rl")).toBe(0);
  });

  it("an offline machine with no live agents arms no reap deadline", async () => {
    const t0 = base();
    await setClock(t0);
    const m = await machine("Empty");
    const d = await connect(m.token);
    await goOffline(d, m.id);
    await alarmAtTime(t0 + 1);
    const at = await alarmAt();
    expect(at).not.toBe(t0 + OFFLINE_REAP_MS);
  });

  it("a machine offline before the deploy (no disconnected_at) starts counting at the wake, not at the alarm", async () => {
    const t0 = base();
    await setClock(t0);
    const m = await machine("Legacy");
    const d = await connect(m.token);
    const name = await reg(d, "l", uniq("Legacy"), ns("legacy"));
    await goOffline(d, m.id);
    // As a hub that predates the column: offline, live agents, no timestamp.
    await inHub((_, s) =>
      s.storage.sql.exec(
        "update machines set disconnected_at = null where id = ?",
        m.id,
      ),
    );
    // The alarm never backfills nor reaps it.
    await alarmAtTime(t0 + 3 * OFFLINE_REAP_MS);
    expect(await liveOf(m.id)).toEqual([name]);
    expect(await disconnectedAt(m.id)).toBeNull();

    // The wake (a fresh instance, real time) starts the clock and arms.
    await inHub((_, s) => s.storage.deleteAlarm());
    const before = Date.now();
    await inHub((_, s) => {
      new BusHub(s, e);
    });
    const after = Date.now();
    const since = (await disconnectedAt(m.id)) as number;
    expect(since).toBeGreaterThanOrEqual(before);
    expect(since).toBeLessThanOrEqual(after);
    let armed: number | null = null;
    for (let k = 0; k < 100 && armed === null; k++) {
      armed = await alarmAt();
      if (armed === null) await new Promise((r) => setTimeout(r, 5));
    }
    expect(armed).not.toBeNull();
    expect(armed as number).toBeLessThanOrEqual(since + OFFLINE_REAP_MS);

    await alarmAtTime(since + OFFLINE_REAP_MS - 1);
    expect(await liveOf(m.id)).toEqual([name]);
    await alarmAtTime(since + OFFLINE_REAP_MS);
    expect(await liveOf(m.id)).toEqual([]);
  });

  it("a due machine that is online after all only has its clock cleared", async () => {
    const t0 = base();
    await setClock(t0);
    const m = await machine("Stale");
    const d = await connect(m.token);
    const name = await reg(d, "s", uniq("Stale"), ns("stale"));
    // A missed clear: the timestamp is old but the socket is open.
    await inHub((_, s) =>
      s.storage.sql.exec(
        "update machines set disconnected_at = ? where id = ?",
        t0 - 2 * OFFLINE_REAP_MS,
        m.id,
      ),
    );
    await alarmAtTime(t0);
    expect(await disconnectedAt(m.id)).toBeNull();
    expect(await liveOf(m.id)).toEqual([name]);
    expect(stateOf(await list(d, "s"), name)).toBe("live");
    d.close();
  });

  it("more than BATCH agents close across continuation steps, then stop", async () => {
    const t0 = base();
    await setClock(t0);
    const m = await machine("Many");
    const d = await connect(m.token);
    const n = ns("many");
    const total = SWEEP_BATCH + 7;
    for (let k = 0; k < total; k++) await reg(d, `m${k}`, uniq("Many"), n);
    await goOffline(d, m.id);
    const t = t0 + OFFLINE_REAP_MS;
    // Earlier tests' offline machines come due first; reaped out of the way.
    await alarmAtTime(t - 1);
    expect(await liveOf(m.id)).toHaveLength(total);
    await alarmAtTime(t);
    expect(await liveOf(m.id)).toHaveLength(7);
    // A full batch re-arms at now + 1 (the continuation).
    expect(await alarmAt()).toBe(t + 1);
    await runAlarm();
    expect(await liveOf(m.id)).toHaveLength(0);
    // Done: no further now + 1 continuation for it.
    const next = await alarmAt();
    expect(next === null || next > t + 1).toBe(true);
  });

  it("a sender's pending mail to a reaped agent expires as recipient_closed", async () => {
    const t0 = base();
    await setClock(t0);
    const away = await machine("Inbox");
    const from = await machine("Sender");
    const n = ns("inbox");
    const a = await connect(away.token);
    const s = await connect(from.token);
    const to = await reg(a, "i", uniq("Inbox"), n);
    await reg(s, "x", uniq("Sender"), n);
    await goOffline(a, away.id);
    const r = await send(s, "x", to);
    expect(r.state).toBe("pending");
    await alarmAtTime(t0 + OFFLINE_REAP_MS);
    for (;;) {
      const f = await s.next();
      if (f.type === "receipt_update" && f.msg_id === r.msg_id) {
        expect(f).toMatchObject({
          state: "expired",
          reason: "recipient_closed",
        });
        break;
      }
    }
    s.close();
  });

  it("webSocketError starts the offline clock", async () => {
    const t0 = base();
    await setClock(t0);
    const m = await machine("Errs");
    const d = await connect(m.token);
    await reg(d, "w", uniq("Errs"), ns("errs"));
    await inHub(async (i, s) => {
      const ws = s.getWebSockets(m.id)[0];
      if (!ws) throw new Error("no socket");
      await i.webSocketError(ws, new Error("boom"));
    });
    expect(await disconnectedAt(m.id)).toBe(t0);
    expect((await d.closed).code).toBe(1011);
  });

  it("wipe keeps the column: a wiped hub still records a machine offline", async () => {
    const who = await member();
    const stub = await hubOf(who.userId);
    await stub.wipe();
    const cols = await inHub(
      (_, s) =>
        s.storage.sql
          .exec<{ name: string }>(
            "select name from pragma_table_info('machines')",
          )
          .toArray()
          .map((r) => r.name),
      who.userId,
    );
    expect(cols).toContain("disconnected_at");
    const m = await machine("Wiped", who.userId);
    const d = await connect(m.token);
    await reg(d, "z", uniq("Wiped"), ns("wiped"));
    expect(await goOffline(d, m.id, who.userId)).toEqual(expect.any(Number));
  });
});

// #1350: closeAll runs for a transient access change (the daemon reconnects
// in seconds) and for a revocation (its machines never come back). Only a
// revocation starts the offline clock. Each test uses its own member's hub:
// closeAll writes revokedAt, which would refuse the owner hub's later connects.
describe("closeAll and the offline clock (#1350)", () => {
  /** A member's hub with one machine and one live agent; hub time `t0`. */
  async function setup(tag: string) {
    const who = await member();
    const uid = who.userId;
    // Behind real time: a reconnect after closeAll is authorized past
    // revokedAt + SKEW_MS.
    const t0 = Date.now() - 60_000;
    const m = await machine(tag, uid);
    const d = await connect(m.token);
    const name = await reg(d, "c", uniq(tag), ns(tag.toLowerCase()));
    await setClock(t0, uid);
    return { uid, t0, m, d, name, stub: await hubOf(uid) };
  }

  it('closeAll "access" leaves the clock unset; a reconnect reaps nothing', async () => {
    const { uid, t0, m, d, name, stub } = await setup("Access");
    expect(await stub.closeAll("space role lowered", "access")).toBe(1);
    expect((await d.closed).code).toBe(4403);
    await new Promise((r) => setTimeout(r, 20));
    expect(await disconnectedAt(m.id, uid)).toBeNull();
    const d2 = await connect(m.token);
    await alarmAtTime(t0 + 2 * OFFLINE_REAP_MS, uid);
    expect(await liveOf(m.id, uid)).toEqual([name]);
    expect(await disconnectedAt(m.id, uid)).toBeNull();
    d2.close();
  });

  it('closeAll "revoked" starts the clock; the agents are reaped at 24 h, not before', async () => {
    const { uid, t0, m, d, name, stub } = await setup("Revoked");
    expect(await stub.closeAll("user suspended", "revoked")).toBe(1);
    expect((await d.closed).code).toBe(4403);
    expect(await disconnectedAt(m.id, uid)).toBe(t0);
    const at = await inHub((_, s) => s.storage.getAlarm(), uid);
    expect(at).not.toBeNull();
    expect(at as number).toBeLessThanOrEqual(t0 + OFFLINE_REAP_MS);
    await alarmAtTime(t0 + OFFLINE_REAP_MS - 1, uid);
    expect(await liveOf(m.id, uid)).toEqual([name]);
    await alarmAtTime(t0 + OFFLINE_REAP_MS, uid);
    expect(await liveOf(m.id, uid)).toEqual([]);
  });

  it("closeAll with no kind follows the reason: transient ones are access, the rest revoked", async () => {
    expect(busCloseKind("space role lowered")).toBe("access");
    expect(busCloseKind("removed from space")).toBe("access");
    expect(busCloseKind("artifacts transferred")).toBe("access");
    expect(busCloseKind("member restored")).toBe("access");
    expect(busCloseKind("member revived")).toBe("access");
    for (const r of [
      "user suspended",
      "role changed",
      "restricted",
      "member erased",
      "guest removed",
      "identity reset",
      "directory delete",
      "suspended",
      "anything new",
    ])
      expect(busCloseKind(r)).toBe("revoked");
    const { uid, t0, m, stub } = await setup("Default");
    await stub.closeAll("suspended");
    expect(await disconnectedAt(m.id, uid)).toBe(t0);
  });

  it("revokeMachine closes the machine's agents at once, never waiting for the reap", async () => {
    const { uid, m, d, stub } = await setup("Gone");
    expect(await stub.revokeMachine(m.id)).toBe(true);
    expect((await d.closed).code).toBe(4403);
    expect(await liveOf(m.id, uid)).toEqual([]);
    expect(await disconnectedAt(m.id, uid)).toBeNull();
  });
});
