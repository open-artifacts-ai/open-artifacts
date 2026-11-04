// Ported from OpenBus v0.63.0 apps/server/test/hub.status.test.ts (#1291).
// Dropped: the client-version gate on roster status ("a 0.53.0 daemon's roster
// carries no status"); the REST agent view is the hub's snapshot() (BusAgentSchema).
// AC3: self-reported status. Storage on the agent row, the coalescing 5 s
// limit (first update at once, the last one from the alarm), the clears on
// every close, and a pending update across an
// eviction. Time is a frozen BusHub.setTestClock an hour ahead of wall time, so
// the real alarm never fires on its own; runDurableObjectAlarm runs it.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  LIMITS,
  newId,
  STATUS_WINDOW_MS,
  StatusLabelSchema,
} from "@oa/bus-protocol";
import { BusAgentSchema } from "@oa/shared";
import { afterEach, describe, expect, it } from "vitest";
import { BusHub, OWNER_ORG_ID } from "../../src/bus/hub.js";
import {
  applyDueStatus,
  applyStatus,
  cleanStatusLabel,
  clearStatus,
} from "../../src/bus/status.js";
import {
  type Daemon,
  daemon,
  e,
  framesSeen,
  hubOf,
  inOwnerHub,
  machine,
  ns,
  up,
  waitFor,
} from "./helpers.js";

const CLIENT = "0.1.0";
const stub = () => hubOf();
const inHub = async <R>(fn: (i: BusHub, s: DurableObjectState) => R) =>
  runInDurableObject(await stub(), fn);
const setClock = (ms: number | null) =>
  inHub((i) => BusHub.setTestClock(i, ms));
const runAlarm = async () => runDurableObjectAlarm(await stub());

afterEach(async () => {
  await setClock(null);
});

let seq = 0;
const id = (t: string) => `${t}${++seq}`;

async function at(version: string = CLIENT): Promise<Daemon> {
  const d = await daemon((await machine()).token);
  d.send({
    v: 1,
    id: id("h"),
    type: "hello",
    machine_label: "M",
    client_version: version,
  });
  await waitFor(d, "hello_ok");
  return d;
}

async function register(
  d: Daemon,
  ref: string,
  name: string,
  namespace: string,
): Promise<string> {
  d.send(up(id("u"), ref, name, namespace));
  expect((await waitFor(d, "agent_ok")).bus_name).toBe(name);
  return inOwnerHub(
    (s) =>
      s.storage.sql
        .exec<{ id: string }>(
          "select id from agents where native_ref = ? and live = 1 and namespace = ?",
          ref,
          namespace,
        )
        .one().id,
  );
}

/** A hello round trip, so every frame sent before it has been processed. */
async function barrier(d: Daemon, version: string = CLIENT): Promise<void> {
  const h = id("b");
  d.send({
    v: 1,
    id: h,
    type: "hello",
    machine_label: "M",
    client_version: version,
  });
  while ((await waitFor(d, "hello_ok")).id !== h);
}

function status(
  d: Daemon,
  from_ref: string,
  state: string,
  label?: string,
): string {
  const fid = id("st");
  // Raw JSON: some cases are deliberately invalid.
  d.ws.send(
    JSON.stringify({
      v: 1,
      id: fid,
      type: "status",
      from_ref,
      state,
      ...(label === undefined ? {} : { label }),
    }),
  );
  return fid;
}

type Cols = {
  status: string | null;
  status_label: string | null;
  status_at: number | null;
  status_next: string | null;
  status_due: number | null;
};
const cols = (agentId: string) =>
  inOwnerHub(
    (s) =>
      s.storage.sql
        .exec<Cols>(
          "select status, status_label, status_at, status_next, status_due from agents where id = ?",
          agentId,
        )
        .one() as Cols,
  );
const NONE: Cols = {
  status: null,
  status_label: null,
  status_at: null,
  status_next: null,
  status_due: null,
};

const restOf = async (agentId: string) =>
  (await (await hubOf()).snapshot()).agents.find((a) => a.id === agentId);

/** The raw JSON of the roster reply to a list from `ref`. */
async function rawRoster(d: Daemon, ref: string): Promise<unknown> {
  const lid = id("l");
  d.send({ v: 1, id: lid, type: "list", from_ref: ref });
  while ((await waitFor(d, "roster")).id !== lid);
  const raw = d.raw.find(
    (t) => t.includes('"roster"') && t.includes(`"${lid}"`),
  ) as string;
  return JSON.parse(raw);
}

const errorsFor = (d: Daemon, fid: string) =>
  framesSeen(d).filter((f) => f.id === fid);

const closeAll = (...ds: Daemon[]) => {
  for (const d of ds)
    try {
      d.close();
    } catch {
      // Already closed.
    }
};

describe("status over the wire", () => {
  it("the first update applies at once (REST, gated roster), no reply, peers told", async () => {
    const t0 = Date.now() + 3_600_000;
    const d = await at();
    const peer = await at();
    try {
      const n = ns("st1");
      const a = await register(d, "s-a", "Alpha", n);
      await register(peer, "s-p", "Peer", n);
      await barrier(peer);
      await setClock(t0);
      const before = peer.raw.length;
      const fid = status(d, "s-a", "working", "fixing CI");
      await barrier(d);
      expect(errorsFor(d, fid)).toEqual([]);

      const rest = await restOf(a);
      expect(rest).toMatchObject({
        status: "working",
        statusLabel: "fixing CI",
        statusAt: new Date(t0).toISOString(),
      });
      expect(BusAgentSchema.safeParse(rest).success).toBe(true);

      const roster = (await rawRoster(peer, "s-p")) as {
        agents: Record<string, unknown>[];
      };
      expect(roster.agents.find((r) => r.bus_name === "Alpha")).toMatchObject({
        status: "working",
        status_label: "fixing CI",
        status_at: new Date(t0).toISOString(),
      });
      expect(
        peer.raw
          .slice(before)
          .some((t) => t.includes('"roster_changed"') && t.includes(n)),
      ).toBe(true);
    } finally {
      closeAll(d, peer);
    }
  });

  it("coalesces a burst: the first shows, the last applies when the window closes", async () => {
    const t0 = Date.now() + 3_600_000;
    const d = await at();
    const peer = await at();
    try {
      const n = ns("st2");
      const a = await register(d, "s-a", "Alpha", n);
      await register(peer, "s-p", "Peer", n);
      await setClock(t0);
      status(d, "s-a", "working", "one");
      await barrier(d);
      await setClock(t0 + 1000);
      status(d, "s-a", "blocked", "two");
      await barrier(d);
      await setClock(t0 + 2000);
      const last = status(d, "s-a", "waiting_on_owner", "three");
      await barrier(d);
      expect(errorsFor(d, last)).toEqual([]);

      expect(await restOf(a)).toMatchObject({
        status: "working",
        statusLabel: "one",
      });
      const c = await cols(a);
      expect(c.status_due).toBe(t0 + STATUS_WINDOW_MS);
      expect(JSON.parse(c.status_next as string)).toEqual({
        state: "waiting_on_owner",
        label: "three",
      });
      const alarm = await inHub((_, s) => s.storage.getAlarm());
      expect(alarm).not.toBeNull();
      expect(alarm as number).toBeLessThanOrEqual(t0 + STATUS_WINDOW_MS);

      await barrier(peer);
      const before = peer.raw.length;
      await setClock(t0 + STATUS_WINDOW_MS);
      expect(await runAlarm()).toBe(true);
      expect(await restOf(a)).toMatchObject({
        status: "waiting_on_owner",
        statusLabel: "three",
        statusAt: new Date(t0 + STATUS_WINDOW_MS).toISOString(),
      });
      expect(await cols(a)).toMatchObject({
        status_next: null,
        status_due: null,
      });
      await barrier(peer);
      expect(
        peer.raw
          .slice(before)
          .some((t) => t.includes('"roster_changed"') && t.includes(n)),
      ).toBe(true);
    } finally {
      closeAll(d, peer);
    }
  });

  it("an identical update sends no roster_changed and keeps statusAt (review M1)", async () => {
    const t0 = Date.now() + 3_600_000;
    const d = await at();
    const peer = await at();
    try {
      const n = ns("st7");
      const a = await register(d, "s-a", "Alpha", n);
      await register(peer, "s-p", "Peer", n);
      await setClock(t0);
      status(d, "s-a", "working", "same");
      await barrier(d);
      await barrier(peer);
      const before = peer.raw.length;
      await setClock(t0 + STATUS_WINDOW_MS);
      const fid = status(d, "s-a", "working", "same");
      await barrier(d);
      await barrier(peer);
      expect(errorsFor(d, fid)).toEqual([]);
      expect(
        peer.raw.slice(before).some((t) => t.includes('"roster_changed"')),
      ).toBe(false);
      expect((await restOf(a))?.statusAt).toBe(new Date(t0).toISOString());
    } finally {
      closeAll(d, peer);
    }
  });

  it("an update without a label clears the label", async () => {
    const t0 = Date.now() + 3_600_000;
    const d = await at();
    try {
      const a = await register(d, "s-a", "Alpha", ns("st3"));
      await setClock(t0);
      status(d, "s-a", "working", "x");
      await barrier(d);
      await setClock(t0 + STATUS_WINDOW_MS);
      status(d, "s-a", "idle");
      await barrier(d);
      const rest = await restOf(a);
      expect(rest?.status).toBe("idle");
      expect(rest && "statusLabel" in rest).toBe(false);
    } finally {
      closeAll(d);
    }
  });

  it("refuses an invalid status with bad_frame and a stranger's ref with not_registered", async () => {
    const d = await at();
    try {
      const a = await register(d, "s-a", "Alpha", ns("st4"));
      const cases = [
        status(d, "s-a", "busy"),
        status(d, "s-a", "working", "x".repeat(LIMITS.maxLabelChars + 1)),
        status(d, "s-a", "working", "evil\u202Elabel"),
        status(d, "s-a", "working", " padded"),
        status(d, "s-a", "working", ""),
      ];
      const stranger = status(d, "s-nobody", "working");
      await barrier(d);
      for (const fid of cases)
        expect(errorsFor(d, fid)).toMatchObject([
          { type: "error", code: "bad_frame" },
        ]);
      expect(errorsFor(d, stranger)).toMatchObject([
        { type: "error", code: "not_registered" },
      ]);
      expect(await cols(a)).toEqual(NONE);
    } finally {
      closeAll(d);
    }
  });

  it("stores the label NFC-normalized", async () => {
    const t0 = Date.now() + 3_600_000;
    const d = await at();
    try {
      const a = await register(d, "s-a", "Alpha", ns("st5"));
      await setClock(t0);
      status(d, "s-a", "working", "Cafe\u0301");
      await barrier(d);
      expect((await restOf(a))?.statusLabel).toBe("Caf\u00e9");
    } finally {
      closeAll(d);
    }
  });
});

describe("close clears applied and pending status (Review Focus 5)", () => {
  async function pendingOn(
    d: Daemon,
    ref: string,
    n: string,
    t0: number,
  ): Promise<string> {
    const a = await register(d, ref, `N${seq}x`, n);
    await setClock(t0);
    status(d, ref, "working", "first");
    await barrier(d);
    await setClock(t0 + 1000);
    status(d, ref, "blocked", "pending");
    await barrier(d);
    expect((await cols(a)).status_due).toBe(t0 + STATUS_WINDOW_MS);
    // Armed for the pending update before the close (review M5).
    const armed = await inHub((_, s) => s.storage.getAlarm());
    expect(armed).not.toBeNull();
    expect(armed as number).toBeLessThanOrEqual(t0 + STATUS_WINDOW_MS);
    return a;
  }

  async function alarmAppliesNothing(t0: number, ids: string[]) {
    // Unconditionally, on a fresh instance, as after an eviction (review M5).
    await inHub(async (_, s) => {
      const fresh = new BusHub(s, e);
      BusHub.setTestClock(fresh, t0 + STATUS_WINDOW_MS);
      await fresh.alarm();
    });
    for (const a of ids) expect(await cols(a)).toEqual(NONE);
  }

  it("agent_down, then the alarm applies nothing; the reopened session has none", async () => {
    const t0 = Date.now() + 3_600_000;
    const d = await at();
    try {
      const n = ns("cl1");
      const a = await pendingOn(d, "s-a", n, t0);
      d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "s-a" });
      await barrier(d);
      expect(await cols(a)).toEqual(NONE);
      await alarmAppliesNothing(t0, [a]);
      expect(await register(d, "s-a", `R${seq}`, n)).toBe(a);
      expect(await cols(a)).toEqual(NONE);
    } finally {
      closeAll(d);
    }
  });

  it("sessions{closed}", async () => {
    const t0 = Date.now() + 3_600_000;
    const d = await at();
    try {
      const a = await pendingOn(d, "s-a", ns("cl2"), t0);
      d.send({
        v: 1,
        id: id("s"),
        type: "sessions",
        open: [],
        closed: ["s-a"],
      });
      await barrier(d);
      expect(await cols(a)).toEqual(NONE);
      await alarmAppliesNothing(t0, [a]);
    } finally {
      closeAll(d);
    }
  });

  it("machine revoke", async () => {
    const t0 = Date.now() + 3_600_000;
    const m = await machine();
    const d = await daemon(m.token);
    try {
      d.send({
        v: 1,
        id: id("h"),
        type: "hello",
        machine_label: "M",
        client_version: CLIENT,
      });
      await waitFor(d, "hello_ok");
      const a = await pendingOn(d, "s-a", ns("cl3"), t0);
      expect(await (await hubOf()).revokeMachine(m.id)).toBe(true);
      expect(await cols(a)).toEqual(NONE);
      await alarmAppliesNothing(t0, [a]);
    } finally {
      closeAll(d);
    }
  });

  it("a live agent moving namespace keeps its status; a reopen clears a stale one", async () => {
    const t0 = Date.now() + 3_600_000;
    const d = await at();
    try {
      const a = await register(d, "s-a", "Mover", ns("mv1"));
      await setClock(t0);
      status(d, "s-a", "working", "kept");
      await barrier(d);
      expect(await register(d, "s-a", "Mover", ns("mv2"))).toBe(a);
      expect(await cols(a)).toMatchObject({
        status: "working",
        status_label: "kept",
      });
      // A closed row carrying status (never left by a close) loses it on reopen.
      d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "s-a" });
      await barrier(d);
      await inOwnerHub((s) =>
        s.storage.sql.exec(
          "update agents set status = 'idle', status_at = 1, status_next = '{}', status_due = 2 where id = ?",
          a,
        ),
      );
      await register(d, "s-a", "Mover", ns("mv3"));
      expect(await cols(a)).toEqual(NONE);
    } finally {
      closeAll(d);
    }
  });
});

describe("eviction (Review Focus 5)", () => {
  it("a pending update persisted in SQLite applies from a fresh instance", async () => {
    const t0 = Date.now() + 3_600_000;
    const d = await at();
    try {
      const a = await register(d, "s-a", "Alpha", ns("ev1"));
      await setClock(t0);
      status(d, "s-a", "working", "first");
      await barrier(d);
      await setClock(t0 + 1000);
      status(d, "s-a", "blocked", "survives");
      await barrier(d);

      // The alarm is lost with the instance; a fresh one re-arms on wake.
      await inHub((_, s) => s.storage.deleteAlarm());
      await inHub((_, s) => {
        new BusHub(s, e);
      });
      const armed = await inHub((_, s) => s.storage.getAlarm());
      expect(armed).not.toBeNull();
      expect(armed as number).toBeLessThanOrEqual(t0 + STATUS_WINDOW_MS);

      // A fresh instance (no in-memory state) runs the alarm.
      await inHub(async (_, s) => {
        const fresh = new BusHub(s, e);
        BusHub.setTestClock(fresh, t0 + STATUS_WINDOW_MS);
        await fresh.alarm();
      });
      expect(await restOf(a)).toMatchObject({
        status: "blocked",
        statusLabel: "survives",
        statusAt: new Date(t0 + STATUS_WINDOW_MS).toISOString(),
      });
      expect(await cols(a)).toMatchObject({
        status_next: null,
        status_due: null,
      });
    } finally {
      closeAll(d);
    }
  });
});

describe("status.ts", () => {
  /** Runs `fn` on a seeded live agent row in the owner hub. */
  const onRow = <R>(fn: (sql: SqlStorage, agentId: string) => R) =>
    inOwnerHub((s) => {
      const sql = s.storage.sql;
      const agentId = newId();
      sql.exec(
        `insert into agents (id, org_id, namespace, name, kind, machine_id, native_ref, live, updated_at)
         values (?, ?, 'test.local/unit', ?, 'opencode', ?, ?, 1, 0)`,
        agentId,
        OWNER_ORG_ID,
        `U${agentId.slice(0, 8)}`,
        newId(),
        `ref-${agentId}`,
      );
      return fn(sql, agentId);
    });
  const read = (sql: SqlStorage, agentId: string) =>
    sql
      .exec<Cols>(
        "select status, status_label, status_at, status_next, status_due from agents where id = ?",
        agentId,
      )
      .one() as Cols;

  it("cleanStatusLabel cleans like a machine label and caps at 64 code points", () => {
    const dirty = `  \u202Eab\u200Bc\u0007 ${"😀".repeat(80)}  `;
    const out = cleanStatusLabel(dirty) as string;
    expect(StatusLabelSchema.safeParse(out).success).toBe(true);
    expect([...out].length).toBeLessThanOrEqual(LIMITS.maxLabelChars);
    expect(out.startsWith("abc")).toBe(true);
    expect(cleanStatusLabel(" \u200B ")).toBeNull();
    expect(cleanStatusLabel(undefined)).toBeNull();
    expect(cleanStatusLabel("Cafe\u0301")).toBe("Caf\u00e9");
  });

  it("applyStatus applies, then coalesces; a late update applies and drops the pending one", () =>
    onRow((sql, a) => {
      expect(applyStatus(sql, a, { state: "working" }, 1000)).toEqual({
        applied: true,
        due: null,
      });
      expect(
        applyStatus(sql, a, { state: "idle", label: "\u202Ex" }, 2000),
      ).toEqual({
        applied: false,
        due: 1000 + STATUS_WINDOW_MS,
      });
      expect(JSON.parse(read(sql, a).status_next as string)).toEqual({
        state: "idle",
        label: "x",
      });
      // Past the window, before the alarm ran: applies now, pending dropped.
      expect(applyStatus(sql, a, { state: "blocked" }, 7000)).toEqual({
        applied: true,
        due: null,
      });
      expect(read(sql, a)).toEqual({
        ...NONE,
        status: "blocked",
        status_at: 7000,
      });
      expect(applyDueStatus(sql, 99_999, 50)).not.toContainEqual(
        expect.objectContaining({ id: a }),
      );
    }));

  it("an identical update writes nothing, keeps status_at and drops a pending one (review M1)", () =>
    onRow((sql, a) => {
      applyStatus(sql, a, { state: "working", label: "x" }, 1000);
      applyStatus(sql, a, { state: "idle" }, 2000);
      expect(read(sql, a).status_due).toBe(1000 + STATUS_WINDOW_MS);
      // Inside the window: the last update equals the applied one.
      expect(
        applyStatus(sql, a, { state: "working", label: "x" }, 3000),
      ).toEqual({ applied: false, due: null });
      const same = {
        ...NONE,
        status: "working",
        status_label: "x",
        status_at: 1000,
      };
      expect(read(sql, a)).toEqual(same);
      // Past the window.
      expect(
        applyStatus(sql, a, { state: "working", label: "x" }, 9000),
      ).toEqual({ applied: false, due: null });
      expect(read(sql, a)).toEqual(same);
      // A different label is a change.
      expect(applyStatus(sql, a, { state: "working" }, 9000)).toEqual({
        applied: true,
        due: null,
      });
    }));

  it("applyDueStatus applies only due rows, bounded; clearStatus clears all five", () =>
    onRow((sql, a) => {
      applyStatus(sql, a, { state: "working" }, 1000);
      applyStatus(sql, a, { state: "idle", label: "later" }, 2000);
      // Other tests' unit rows may share the hub: match on this row only.
      const mine = { id: a };
      expect(applyDueStatus(sql, 5999, 50)).not.toContainEqual(
        expect.objectContaining(mine),
      );
      expect(applyDueStatus(sql, 6000, 0)).toEqual([]);
      expect(applyDueStatus(sql, 6000, 50)).toContainEqual(
        expect.objectContaining(mine),
      );
      expect(read(sql, a)).toEqual({
        ...NONE,
        status: "idle",
        status_label: "later",
        status_at: 6000,
      });
      applyStatus(sql, a, { state: "blocked" }, 7000);
      clearStatus(sql, [a]);
      expect(read(sql, a)).toEqual(NONE);
    }));
});
