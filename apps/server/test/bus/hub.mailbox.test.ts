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
import { BusHub, OFFLINE_REAP_MS } from "../../src/bus/hub.js";
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

describe("lasting mailboxes (#1295 PR A)", () => {
  it("1: mail to a closed agent is pending, not refused; a reopen with the same agent_ref gets it", async () => {
    const t0 = base();
    const p = await pair(t0);
    await close(p.rcv, p.ref);
    const r = await send(p.snd, "snd", p.name, "while away");
    expect(r.state).toBe("pending");
    p.rcv.send(up(id("u"), p.ref, p.name, p.n));
    const ok = await waitFor(p.rcv, "agent_ok");
    expect(ok.bus_name).toBe(p.name);
    const d = await waitFor(p.rcv, "deliver");
    expect(d.msg_id).toBe(r.msg_id);
    expect("body" in d && d.body).toBe("while away");
    p.rcv.close();
    p.snd.close();
  });

  it("2: another agent_ref proposing the reserved name gets -2 and none of the mail", async () => {
    const t0 = base();
    const p = await pair(t0);
    await close(p.rcv, p.ref);
    const r = await send(p.snd, "snd", p.name);
    expect(r.state).toBe("pending");
    const om = await machine("Other");
    const o = await connect(om.token);
    expect(await reg(o, uniq("other"), p.name, p.n)).toBe(`${p.name}-2`);
    await new Promise((res) => setTimeout(res, 50));
    expect(o.raw.some((t) => t.includes('"deliver"'))).toBe(false);
    o.close();
    p.rcv.close();
    p.snd.close();
  });

  it("3: at +7 d the sender is told expired and the name is free", async () => {
    const t0 = base();
    const p = await pair(t0);
    await close(p.rcv, p.ref);
    const r = await send(p.snd, "snd", p.name);
    expect(r.state).toBe("pending");
    await setClock(t0 + MAILBOX_RETAIN_MS + 1000);
    await runAlarm();
    const u = await waitFor(p.snd, "receipt_update");
    expect(u).toMatchObject({ msg_id: r.msg_id, state: "expired" });
    const om = await machine("Other");
    const o = await connect(om.token);
    expect(await reg(o, uniq("other"), p.name, p.n)).toBe(p.name);
    o.close();
    p.rcv.close();
    p.snd.close();
  });

  it("4a: the 201st pending message to one address is refused inbox_full", async () => {
    const t0 = base();
    const p = await pair(t0);
    await close(p.rcv, p.ref);
    for (let k = 0; k < MAILBOX_PENDING_CAP; k++)
      expect((await send(p.snd, "snd", p.name, `m${k}`)).state).toBe("pending");
    expect(await send(p.snd, "snd", p.name, "one too many")).toMatchObject({
      state: "refused",
      reason: "inbox_full",
    });
    p.rcv.close();
    p.snd.close();
  }, 60_000);

  it("4b: bytes past 10 MB pending for one address are refused inbox_full", async () => {
    const t0 = base();
    const p = await pair(t0);
    await close(p.rcv, p.ref);
    const big = "x".repeat(1024 * 1024);
    for (let k = 0; k < 10; k++)
      expect((await send(p.snd, "snd", p.name, big)).state).toBe("pending");
    expect(await send(p.snd, "snd", p.name, "y")).toMatchObject({
      state: "refused",
      reason: "inbox_full",
    });
    p.rcv.close();
    p.snd.close();
  }, 60_000);

  it("4c: past the hub-wide 1 GB pending total a send is refused inbox_full", async () => {
    // Past the byte total's 30 s refresh window of the tests before it.
    const t0 = base() + 10 * 60_000;
    const p = await pair(t0);
    await close(p.rcv, p.ref);
    // A pending receipt that only counts bytes, to a third address.
    await inHub((_, s) => {
      s.storage.sql.exec(
        `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at)
         select 'seed-gb', org_id, namespace, id, name, id, name, 'pending', ?, ?, ?
           from agents where native_ref = 'snd' order by rowid desc limit 1`,
        HUB_MAILBOX_BYTES_CAP,
        t0,
        t0 + HOUR,
      );
    });
    try {
      expect(await send(p.snd, "snd", p.name, "full")).toMatchObject({
        state: "refused",
        reason: "inbox_full",
      });
    } finally {
      await inHub((_, s) => {
        s.storage.sql.exec("delete from receipts where id = 'seed-gb'");
      });
    }
    p.rcv.close();
    p.snd.close();
  });

  it("5: a closed agent's row is not purged at 24 h while its name is reserved", async () => {
    const t0 = base();
    const p = await pair(t0);
    await close(p.rcv, p.ref);
    await setClock(t0 + 25 * HOUR);
    await runAlarm();
    const rows = await sqlOf(
      "select id from agents where native_ref = ?",
      p.ref,
    );
    expect(rows.length).toBe(1);
    // Past the reservation the idle row goes.
    await setClock(t0 + MAILBOX_RETAIN_MS + DAY);
    await runAlarm();
    await runAlarm();
    expect(
      (await sqlOf("select id from agents where native_ref = ?", p.ref)).length,
    ).toBe(0);
    p.rcv.close();
    p.snd.close();
  });

  it("6: a resend with the same send key after 3 h is deduped while the mail is pending", async () => {
    const t0 = base();
    const p = await pair(t0);
    await close(p.rcv, p.ref);
    const fid = id("same");
    const r = await send(p.snd, "snd", p.name, "once", fid);
    expect(r.state).toBe("pending");
    await setClock(t0 + 3 * HOUR);
    await runAlarm();
    const again = await send(p.snd, "snd", p.name, "once", fid);
    expect(again).toMatchObject({ state: "pending", msg_id: r.msg_id });
    expect(
      (
        await sqlOf<{ n: number }>(
          "select count(*) as n from receipts where to_agent = (select id from agents where native_ref = ?)",
          p.ref,
        )
      )[0]?.n,
    ).toBe(1);
    p.rcv.close();
    p.snd.close();
  });

  it("7: the reap after 24 h offline closes into away, with away_since = disconnected_at", async () => {
    const t0 = base();
    const p = await pair(t0);
    p.rcv.close();
    await p.rcv.closed;
    let disc: number | null = null;
    for (let k = 0; k < 400 && disc === null; k++) {
      disc =
        (
          await sqlOf<{ t: number | null }>(
            "select disconnected_at as t from machines where id = (select machine_id from agents where native_ref = ?)",
            p.ref,
          )
        )[0]?.t ?? null;
      if (disc === null) await new Promise((res) => setTimeout(res, 5));
    }
    expect(disc).toBe(t0);
    // Mail sent while the agent is still live (queued) an hour in.
    await setClock(t0 + HOUR);
    const r = await send(p.snd, "snd", p.name);
    expect(r.state).toBe("pending");
    await setClock(t0 + OFFLINE_REAP_MS);
    await runAlarm();
    const a = await sqlOf<{ live: number; away: number | null }>(
      "select live, away_since as away from agents where native_ref = ?",
      p.ref,
    );
    expect(a[0]).toEqual({ live: 0, away: t0 });
    const f = await sqlOf<{ kind: string; expires_at: number }>(
      "select kind, expires_at from former_names where agent_id = (select id from agents where native_ref = ?)",
      p.ref,
    );
    expect(f).toEqual([{ kind: "away", expires_at: t0 + MAILBOX_RETAIN_MS }]);
    // The pending mail expires with the reservation, not 7 d after the send.
    const m = await sqlOf<{ state: string; expires_at: number }>(
      "select state, expires_at from receipts where id = ?",
      r.msg_id,
    );
    expect(m[0]).toEqual({
      state: "pending",
      expires_at: t0 + MAILBOX_RETAIN_MS,
    });
    p.snd.close();
  });

  it("8: a move or flip still holds the old name 1 h as held, never away", async () => {
    const t0 = base();
    const p = await pair(t0);
    const n2 = ns("mb2");
    p.rcv.send(up(id("u"), p.ref, p.name, n2));
    await waitFor(p.rcv, "agent_ok");
    const f = await sqlOf<{ kind: string; expires_at: number }>(
      "select kind, expires_at from former_names where agent_id = (select id from agents where native_ref = ?)",
      p.ref,
    );
    expect(f).toEqual([{ kind: "held", expires_at: t0 + HOUR }]);
    p.rcv.close();
    p.snd.close();
  });

  it("live agents get the 7 d TTL", async () => {
    const t0 = base();
    const p = await pair(t0);
    const r = await send(p.snd, "snd", p.name);
    const m = await sqlOf<{ expires_at: number }>(
      "select expires_at from receipts where id = ?",
      r.msg_id,
    );
    expect(m[0]?.expires_at).toBe(t0 + MAILBOX_RETAIN_MS);
    p.rcv.close();
    p.snd.close();
  });
});
