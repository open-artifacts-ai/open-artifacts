// #1295 PR A: lasting mailboxes, the hub retention core (no wire change).
// A closed agent (not revoked, not moved) keeps its name as an `away`
// reservation and its pending mail for MAILBOX_RETAIN_MS (7 d); a reopen
// with the same agent_ref gets the mail; per-address caps; send keys of
// pending mail are never purged by age. Time is BusHub.setTestClock, always
// ahead of real time and reset after each test.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  type ClientFrame,
  HUB_MAILBOX_BYTES_CAP,
  MAILBOX_PENDING_CAP,
  MAILBOX_RETAIN_MS,
  type ServerFrame,
} from "@oa/bus-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  BusHub,
  CLOSED_AGENTS_PER_MACHINE,
  OFFLINE_REAP_MS,
} from "../../src/bus/hub.js";
import {
  type Daemon,
  daemon,
  hello,
  hubOf,
  machine,
  ns,
  up,
  waitFor,
} from "./helpers.js";

const inHub = async <R>(fn: (i: BusHub, s: DurableObjectState) => R) =>
  runInDurableObject(await hubOf(), fn);
const setClock = (ms: number | null) =>
  inHub((i) => BusHub.setTestClock(i, ms));
const runAlarm = async () => runDurableObjectAlarm(await hubOf());
const sqlOf = <T extends Record<string, SqlStorageValue>>(
  q: string,
  ...binds: SqlStorageValue[]
) =>
  inHub(
    (_, s) => s.storage.sql.exec<T>(q, ...binds).toArray() as unknown as T[],
  );

afterEach(async () => {
  await setClock(null);
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The three B1 tests below drive a whole machine's churn over the wire: one
 * up and one close per closed agent, then one answer read for each.
 *
 * Worst measured wall time of one such phase: 34 s (1020 one-shot sessions,
 * this file alone, host load average 16 on 24 cores) and 24 s (999 ups plus
 * 999 closes, eight copies of this file at once); per-frame arrival gaps
 * under that load p50 23 ms, p99 48 ms, max 93 ms.
 */
const CHURN_PHASE_MS = 34_000;
/**
 * A frame wait's ceiling in a churn phase: the phase's own measured work
 * times three (budgets are derived, never guessed). Not helpers.ts's 15 s,
 * which is a liveness check for one frame after a little work: on run
 * 42098416740 the phase ran healthily for ~22 s and then a single wait spent
 * its whole 15 s, a stalled shard rather than a stalled hub (#1533). A frame
 * that really never comes still fails the test, a stalled runner no longer
 * fails it for being slow.
 */
const CHURN_FRAME_WAIT_MS = CHURN_PHASE_MS * 3;
/** One stalled frame wait plus the phase's own work, both derived above. */
const CHURN_TEST_MS = CHURN_FRAME_WAIT_MS + CHURN_PHASE_MS;

let seq = 0;
const id = (t: string) => `${t}${++seq}`;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;
const base = () => Date.now() + 3_600_000 + ++seq * 1000;

type Receipt = Extract<ServerFrame, { type: "receipt" }>;

async function connect(token: string): Promise<Daemon> {
  const d = await daemon(token);
  const h = hello(id("h"));
  d.send(h);
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

function sendFrame(from: string, to: string, body: string, fid = id("s")) {
  return {
    v: 1,
    id: fid,
    type: "send",
    from_ref: from,
    to_name: to,
    body,
  } as ClientFrame;
}

async function receiptFor(d: Daemon, fid: string): Promise<Receipt> {
  for (;;) {
    const f = await d.next();
    if (f.type === "receipt" && f.id === fid) return f;
  }
}

async function send(
  d: Daemon,
  from: string,
  to: string,
  body = "hi",
  fid = id("s"),
): Promise<Receipt> {
  d.send(sendFrame(from, to, body, fid));
  return receiptFor(d, fid);
}

const close = async (d: Daemon, ref: string) => {
  d.send({ v: 1, id: id("c"), type: "sessions", open: [], closed: [ref] });
  // Closes are not acknowledged: wait until the hub has applied it.
  for (let k = 0; k < 400; k++) {
    const r = await sqlOf<{ live: number }>(
      "select live from agents where native_ref = ?",
      ref,
    );
    if (r[0]?.live === 0) return;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error("close never applied");
};

type Pair = { rcv: Daemon; snd: Daemon; n: string; name: string };
async function pair(t0: number): Promise<Pair & { ref: string }> {
  await setClock(t0);
  const rm = await machine("Rcv");
  const sm = await machine("Snd");
  const n = ns("mb");
  const rcv = await connect(rm.token);
  const snd = await connect(sm.token);
  const ref = uniq("r");
  const name = await reg(rcv, ref, uniq("Rcv"), n);
  await reg(snd, "snd", uniq("Snd"), n);
  return { rcv, snd, n, name, ref };
}

describe("historical ordering reproduction", () => {
  it(
    "B1: with pending mail on every closed row, the oldest away agent is evicted, its mail expires recipient_closed and its sender is told",
    async () => {
      const t0 = base();
      const p = await pair(t0);
      const machineId = (
        await sqlOf<{ m: string }>(
          "select machine_id as m from agents where native_ref = ?",
          p.ref,
        )
      )[0]?.m as string;
      await inHub(async (i, st) => {
        for (const ws of st.getWebSockets(machineId))
          BusHub.setFrameTokensForTests(i, ws, 1_000_000);
      });
      // Mail sits on the first closed agent for real.
      await close(p.rcv, p.ref);
      const r = await send(p.snd, "snd", p.name, "kept");
      expect(r.state).toBe("pending");
      const CYCLES = CLOSED_AGENTS_PER_MACHINE - 1;
      for (let k = 0; k < CYCLES; k++) {
        p.rcv.send(up(`bu${k}`, `churn_${k}`, "Churn", p.n));
        if (k < CYCLES - 1) p.rcv.send({
          v: 1,
          id: `bc${k}`,
          type: "sessions",
          open: [],
          closed: [`churn_${k}`],
        });
      }
      for (let k = 0; k < CYCLES; ) {
        const f = await p.rcv.next();
        expect(f.type).not.toBe("error");
        if (f.type === "agent_ok") k++;
      }
      // Positive control: synchronize the final close before seeding.
      await close(p.rcv, `churn_${CYCLES - 1}`);
      // Every closed agent now has an inbox. Seed ids are valid msg ids (an
      // agent id has the same shape), so a sender told about one decodes it.
      await inHub((_, st) => {
        st.storage.sql.exec(
          `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at)
         select a.id, a.org_id, a.namespace, a.id, a.name, s.id, s.name, 'pending', 1, ?, ?
           from agents a, (select id, name from agents where native_ref = 'snd' order by rowid desc limit 1) s
          where a.machine_id = ? and a.live = 0 and a.native_ref != ?`,
          t0,
          t0 + MAILBOX_RETAIN_MS,
          machineId,
          p.ref,
        );
      });
      p.rcv.send(up(id("u"), uniq("fresh"), uniq("Fresh"), p.n));
      expect((await p.rcv.next()).type).toBe("agent_ok");
      expect(await waitFor(p.snd, "receipt_update")).toMatchObject({
        msg_id: r.msg_id,
        state: "expired",
        reason: "recipient_closed",
      });
      const rows = await sqlOf<{ native_ref: string }>("select native_ref from agents where machine_id = ? and native_ref in (?, ?)", machineId, p.ref, `churn_${CYCLES - 1}`);
      expect(rows.map(row => row.native_ref)).toEqual([`churn_${CYCLES - 1}`]);
      await inHub((_, st) => {
        st.storage.sql.exec(
          "delete from receipts where namespace = ? and size = 1 and id in (select id from agents)",
          p.n,
        );
      });
      p.rcv.close();
      p.snd.close();
    },
    120_000,
  );

});
