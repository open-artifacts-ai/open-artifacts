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

  it("B1: a machine closing 1000+ sessions in 7 days is never locked out of new ones", async () => {
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
    const CYCLES = CLOSED_AGENTS_PER_MACHINE + 20;
    for (let k = 0; k < CYCLES; k++) {
      p.rcv.send(up(`bu${k}`, `churn_${k}`, "Churn", p.n));
      p.rcv.send({
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
    // A fresh ref still gets in, and the closed rows stay at the cap.
    p.rcv.send(up(id("u"), uniq("fresh"), uniq("Fresh"), p.n));
    expect((await p.rcv.next()).type).toBe("agent_ok");
    const closed = await sqlOf<{ n: number }>(
      "select count(*) as n from agents where machine_id = ? and live = 0",
      machineId,
    );
    expect(closed[0]?.n).toBeLessThanOrEqual(CLOSED_AGENTS_PER_MACHINE);
    p.rcv.close();
    p.snd.close();
  }, 120_000);

  it("B1: with pending mail on every closed row, the oldest away agent is evicted, its mail expires recipient_closed and its sender is told", async () => {
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
      p.rcv.send({
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
    // Every closed agent now has an inbox.
    await inHub((_, st) => {
      st.storage.sql.exec(
        `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at)
         select 'seed-' || a.id, a.org_id, a.namespace, a.id, a.name, s.id, s.name, 'pending', 1, ?, ?
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
    const u = await waitFor(p.snd, "receipt_update");
    expect(u).toMatchObject({
      msg_id: r.msg_id,
      state: "expired",
      reason: "recipient_closed",
    });
    expect(
      (await sqlOf("select id from agents where native_ref = ?", p.ref)).length,
    ).toBe(0);
    await inHub((_, st) => {
      st.storage.sql.exec("delete from receipts where id like 'seed-%'");
    });
    p.rcv.close();
    p.snd.close();
  }, 120_000);

  it("B2: a global sender with no to_namespace gets ambiguous when two namespaces have an agent away under the name", async () => {
    const t0 = base();
    await setClock(t0);
    const m1 = await machine("A");
    const m2 = await machine("B");
    const m3 = await machine("G");
    const a = await connect(m1.token);
    const b = await connect(m2.token);
    const g = await connect(m3.token);
    const name = uniq("Foo");
    await reg(a, "fa", name, ns("a"));
    await reg(b, "fb", name, ns("b"));
    g.send(up(id("u"), "gs", uniq("Glob"), ns("g"), true));
    await waitFor(g, "agent_ok");
    await close(a, "fa");
    await close(b, "fb");
    expect(await send(g, "gs", name)).toMatchObject({
      state: "refused",
      reason: "ambiguous",
    });
    a.close();
    b.close();
    g.close();
  });

  it("B2: a global and a non-global both away under one name are ambiguous too", async () => {
    const t0 = base();
    await setClock(t0);
    const m1 = await machine("A");
    const m2 = await machine("B");
    const m3 = await machine("G");
    const a = await connect(m1.token);
    const b = await connect(m2.token);
    const g = await connect(m3.token);
    const name = uniq("Foo");
    await reg(a, "fa", name, ns("a"));
    b.send(up(id("u"), "fb", uniq("Glo"), ns("b"), true));
    await waitFor(b, "agent_ok");
    g.send(up(id("u"), "gs", uniq("Sender"), ns("g"), true));
    await waitFor(g, "agent_ok");
    await close(a, "fa");
    await close(b, "fb");
    // The API never lets both hold the name; seed the collision.
    await inHub((_, st) => {
      st.storage.sql.exec(
        "update former_names set name = ?, lname = ? where kind = 'away' and agent_id = (select id from agents where native_ref = 'fb' order by rowid desc limit 1)",
        name,
        name.toLowerCase(),
      );
    });
    expect(await send(g, "gs", name)).toMatchObject({
      state: "refused",
      reason: "ambiguous",
    });
    a.close();
    b.close();
    g.close();
  });

  it("B1: closed agents whose own sends are still pending never lock the machine out; other machines and live agents are untouched", async () => {
    const t0 = base();
    await setClock(t0);
    const rm = await machine("Churn");
    const lm = await machine("Leads");
    const n = ns("lock");
    const r = await connect(rm.token);
    const l = await connect(lm.token);
    const LEADS = 7;
    const leads: string[] = [];
    for (let k = 0; k < LEADS; k++)
      leads.push(await reg(l, `lead${k}`, uniq("Lead"), n));
    const live = await reg(r, "keeper", uniq("Keeper"), n);
    for (let k = 0; k < LEADS; k++) await close(l, `lead${k}`);
    const bystander = await reg(l, "bystander", uniq("By"), n);
    const machineId = (
      await sqlOf<{ m: string }>(
        "select machine_id as m from agents where native_ref = 'keeper' order by rowid desc limit 1",
      )
    )[0]?.m as string;
    await inHub(async (i, st) => {
      for (const ws of st.getWebSockets(machineId))
        BusHub.setFrameTokensForTests(i, ws, 1_000_000);
    });
    const CYCLES = CLOSED_AGENTS_PER_MACHINE + 20;
    // One-shot sessions: each messages an away lead and closes.
    for (let k = 0; k < CYCLES; k++) {
      r.send(up(`ou${k}`, `shot_${k}`, "Shot", n));
      r.send({
        v: 1,
        id: `os${k}`,
        type: "send",
        from_ref: `shot_${k}`,
        to_name: leads[k % LEADS] as string,
        body: "hi",
      } as ClientFrame);
      r.send({
        v: 1,
        id: `oc${k}`,
        type: "sessions",
        open: [],
        closed: [`shot_${k}`],
      });
    }
    let oks = 0;
    let pend = 0;
    while (oks < CYCLES || pend < CYCLES) {
      const f = await r.next();
      expect(f.type).not.toBe("error");
      if (f.type === "agent_ok") oks++;
      if (f.type === "receipt") {
        expect(f.state).toBe("pending");
        pend++;
      }
    }
    r.send(up(id("u"), uniq("fresh"), uniq("Fresh"), n));
    expect((await waitFor(r, "agent_ok")).type).toBe("agent_ok");
    // Only this machine's closed rows went; its live agent and the other
    // machine's agents are intact.
    const count = (q: string) =>
      sqlOf<{ n: number }>(q).then((x) => x[0]?.n as number);
    expect(
      await count(
        `select count(*) as n from agents where machine_id = '${machineId}' and live = 0`,
      ),
    ).toBeLessThanOrEqual(CLOSED_AGENTS_PER_MACHINE);
    expect(
      await count(
        "select count(*) as n from agents where native_ref = 'keeper' and live = 1",
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await count(
        `select count(*) as n from agents where native_ref like 'lead%' and machine_id != '${machineId}' and live = 0`,
      ),
    ).toBeGreaterThanOrEqual(LEADS);
    expect(live).toBeTruthy();
    expect(bystander).toBeTruthy();
    // The evicted senders' sends stay pending; their outcome later finds no
    // sender row and must not throw.
    await setClock(t0 + MAILBOX_RETAIN_MS + 1000);
    const owed =
      "select count(*) as n from receipts where state = 'pending' and from_name like 'Shot%'";
    for (let k = 0; k < 60 && (await count(owed)) > 0; k++) await runAlarm();
    expect(await count(owed)).toBe(0);
    r.close();
    l.close();
  }, 120_000);

  it("a reopen under another name downgrades the old away row to the 1 h held", async () => {
    const t0 = base();
    const p = await pair(t0);
    await close(p.rcv, p.ref);
    const other = uniq("Other");
    p.rcv.send(up(id("u"), p.ref, other, p.n));
    const ok = await waitFor(p.rcv, "agent_ok");
    expect(ok.bus_name).toBe(other);
    const f = await sqlOf<{ kind: string; expires_at: number }>(
      "select kind, expires_at from former_names where agent_id = (select id from agents where native_ref = ?)",
      p.ref,
    );
    expect(f).toEqual([{ kind: "held", expires_at: t0 + HOUR }]);
    // Reserved for the hour, free after.
    const om = await machine("Other");
    const o = await connect(om.token);
    expect(await reg(o, uniq("o"), p.name, p.n)).toBe(`${p.name}-2`);
    await setClock(t0 + HOUR + 1000);
    await runAlarm();
    expect(await reg(o, uniq("o2"), p.name, p.n)).toBe(p.name);
    o.close();
    p.rcv.close();
    p.snd.close();
  });

  it("a reopen after the away row expired starts a new session: old mail is never served", async () => {
    const t0 = base();
    const p = await pair(t0);
    await close(p.rcv, p.ref);
    const big = "z".repeat(40_000);
    const small = await send(p.snd, "snd", p.name, "old small");
    const notice = await send(p.snd, "snd", p.name, big);
    expect([small.state, notice.state]).toEqual(["pending", "pending"]);
    // Past the reservation, alarm not run yet.
    await setClock(t0 + MAILBOX_RETAIN_MS + 1000);
    p.rcv.send(up(id("u"), p.ref, p.name, p.n));
    await waitFor(p.rcv, "agent_ok");
    p.rcv.send({
      v: 1,
      id: "fx",
      type: "fetch",
      from_ref: p.ref,
      msg_id: notice.msg_id,
    } as ClientFrame);
    const e = await waitFor(p.rcv, "error");
    expect(e.id).toBe("fx");
    expect(e.code).toBe("not_found");
    await new Promise((res) => setTimeout(res, 50));
    expect(p.rcv.raw.some((t) => t.includes('"deliver"'))).toBe(false);
    p.rcv.close();
    p.snd.close();
  });

  it("a reopen that keeps its away row cannot fetch any old acked notice body, even past the inline close batch", async () => {
    const t0 = base();
    const p = await pair(t0);
    const big = "z".repeat(40_000);
    // More than CLOSE_INLINE_BATCH (10), so the close leaves bodies for the drain.
    const N = 12;
    const ids: string[] = [];
    for (let k = 0; k < N; k++) {
      const r = await send(p.snd, "snd", p.name, `${big}${k}`);
      ids.push(r.msg_id);
      const d = await waitFor(p.rcv, "deliver");
      expect(d.msg_id).toBe(r.msg_id);
      p.rcv.send({ v: 1, id: `ak${k}`, type: "ack", msg_id: r.msg_id });
    }
    for (let k = 0; k < 400; k++) {
      const st = await sqlOf<{ n: number }>(
        `select count(*) as n from receipts where state = 'delivered' and id in (${ids.map(() => "?").join(",")})`,
        ...ids,
      );
      if (st[0]?.n === N) break;
      await new Promise((res) => setTimeout(res, 5));
    }
    await close(p.rcv, p.ref);
    // The drain has not run: bodies are left past the inline batch.
    expect(
      (
        await sqlOf<{ n: number }>(
          `select count(*) as n from mail where id in (${ids.map(() => "?").join(",")})`,
          ...ids,
        )
      )[0]?.n,
    ).toBeGreaterThan(0);
    p.rcv.send(up(id("u"), p.ref, p.name, p.n));
    await waitFor(p.rcv, "agent_ok");
    for (const [k, mid] of ids.entries()) {
      p.rcv.send({
        v: 1,
        id: `fy${k}`,
        type: "fetch",
        from_ref: p.ref,
        msg_id: mid,
      } as ClientFrame);
      const e = await waitFor(p.rcv, "error");
      expect(e.code).toBe("not_found");
    }
    p.rcv.close();
    p.snd.close();
  });

  it("S1: revoking the machine of an away agent expires its pending mail revoked and frees its name at once", async () => {
    const t0 = base();
    const p = await pair(t0);
    const machineId = (
      await sqlOf<{ m: string }>(
        "select machine_id as m from agents where native_ref = ?",
        p.ref,
      )
    )[0]?.m as string;
    await close(p.rcv, p.ref);
    const r = await send(p.snd, "snd", p.name, "for the revoked");
    expect(r.state).toBe("pending");
    expect(
      (
        await sqlOf<{ n: number }>(
          "select count(*) as n from former_names where kind = 'away' and name = ?",
          p.name,
        )
      )[0]?.n,
    ).toBe(1);
    expect(await (await hubOf()).revokeMachine(machineId)).toBe(true);
    const u = await waitFor(p.snd, "receipt_update");
    // The wire says recipient_closed for a revoked recipient; the row keeps
    // `revoked` for audit.
    expect(u).toMatchObject({
      msg_id: r.msg_id,
      state: "expired",
      reason: "recipient_closed",
    });
    expect(
      (
        await sqlOf<{ reason: string }>(
          "select reason from receipts where id = ?",
          r.msg_id,
        )
      )[0]?.reason,
    ).toBe("revoked");
    expect(
      (
        await sqlOf<{ n: number }>(
          "select count(*) as n from former_names where name = ?",
          p.name,
        )
      )[0]?.n,
    ).toBe(0);
    const om = await machine("Other");
    const o = await connect(om.token);
    expect(await reg(o, uniq("o"), p.name, p.n)).toBe(p.name);
    o.close();
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
