// Ported from OpenBus v0.63.0 apps/server/test/hub.adv-b14.test.ts (#1291).
// Dropped: nothing (machines are D1 rows of the test owner; one owner hub).
// Adversarial probes for B14 (idempotent send), ported from adv-B14 with the
// fix-round-1 rulings: P3 (cap eviction never drops a pending key: one
// deliver, rate_limited at the cap), P5 (own namespace explicit == absent),
// P9 (hub-wide SEND_KEYS_TOTAL cap).
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { type ClientFrame, LIMITS, type ServerFrame } from "@oa/bus-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_FINAL_KEY_SQL,
  BusHub,
  HUB_FINAL_KEY_SQL,
  SEND_KEYS_MESSAGE,
  SEND_KEYS_PER_AGENT,
  SEND_KEYS_TOTAL,
} from "../../src/bus/hub.js";
import { migrateHub } from "../../src/bus/schema.js";
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
afterEach(async () => {
  await setClock(null);
  await inHub((i) => BusHub.setSendKeysTotalForTests(i, null));
});

type Receipt = Extract<ServerFrame, { type: "receipt" }>;
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

async function agent(d: Daemon, ref: string, name: string, n: string) {
  d.send(up(`u-${ref}-${++seq}`, ref, name, n));
  expect((await waitFor(d, "agent_ok")).bus_name).toBe(name);
}
async function barrier(d: Daemon) {
  const id = `b${++seq}`;
  d.send(hello(id));
  for (;;) if ((await waitFor(d, "hello_ok")).id === id) return;
}
async function reply(d: Daemon, f: ClientFrame): Promise<Receipt | ErrorF> {
  d.send(f);
  for (;;) {
    const r = await d.next();
    if ((r.type === "receipt" || r.type === "error") && r.id === f.id) return r;
  }
}
const delivers = (d: Daemon) =>
  framesSeen(d).filter((f) => f.type === "deliver");
async function offline(d: Daemon) {
  d.close();
  await d.closed;
  await new Promise((r) => setTimeout(r, 50));
}

/** Lifts a machine's frame budget so a flood of sends is not rate limited. */
const liftBudget = async (machineId: string) => {
  // A frozen clock keeps the refill from clamping the tokens back to the burst.
  await setClock(Date.now() + 1000);
  await inHub((i, st) => {
    for (const ws of st.getWebSockets(machineId))
      BusHub.setFrameTokensForTests(i, ws, 1_000_000);
  });
};

describe("adv B14", () => {
  it("P1 query plans: find, cap count, cap delete and sweep are indexed", async () => {
    const plans = await inOwnerHub((s) => {
      const q = (x: string, ...b: unknown[]) =>
        s.storage.sql
          .exec<{ detail: string }>(
            `explain query plan ${x}`,
            ...(b as never[]),
          )
          .toArray()
          .map((r) => r.detail)
          .join(" | ");
      return {
        find: q(
          "select payload_hash, msg_id, created_at from send_keys where from_agent = ? and frame_id = ?",
          "a",
          "f",
        ),
        count: q(
          "select count(*) as n from (select 1 from send_keys where from_agent = ? limit ?)",
          "a",
          201,
        ),
        evictAgent: q(AGENT_FINAL_KEY_SQL, "a"),
        evictHub: q(HUB_FINAL_KEY_SQL),
        // Without the hint the planner picks the partial indexes too.
        evictAgentPlain: q(
          "select rowid from send_keys where from_agent = ? and final = 1 order by created_at limit 1",
          "a",
        ),
        evictHubPlain: q(
          "select rowid from send_keys where final = 1 order by created_at limit 1",
        ),
        finalize: q("update send_keys set final = 1 where msg_id = ?", "m"),
        sweep: q(
          "delete from send_keys where rowid in (select rowid from send_keys where created_at < ? limit ?) returning rowid",
          0,
          50,
        ),
        next: q("select min(created_at) as t from send_keys"),
      };
    });
    console.log("PLANS", JSON.stringify(plans, null, 1));
    for (const p of Object.values(plans)) {
      expect(p).not.toMatch(/SCAN send_keys(?! USING)/);
      expect(p).not.toMatch(/TEMP B-TREE/);
    }
    for (const p of [plans.evictAgent, plans.evictAgentPlain])
      expect(p).toMatch(/USING (COVERING )?INDEX send_keys_agent_final/);
    for (const p of [plans.evictHub, plans.evictHubPlain])
      expect(p).toMatch(/INDEX send_keys_final\b/);
    expect(plans.finalize).toMatch(/INDEX send_keys_msg/);
  });

  it("P2 offline recipient: resends before and after the flush never deliver twice", async () => {
    const sm = await machine("S");
    const tm = await machine("T");
    const s = await ready(sm.token);
    let t = await ready(tm.token);
    const n = ns("adv14");
    const sender = uniq("Snd");
    const rcv = uniq("Rcv");
    await agent(s, "sref", sender, n);
    await agent(t, "rref", rcv, n);
    await offline(t);
    const r1 = (await reply(s, send("k1", "sref", rcv))) as Receipt;
    expect(r1.state).toBe("pending");
    // Two resends in the same burst (same DO turn ordering).
    s.send(send("k1", "sref", rcv));
    s.send(send("k1", "sref", rcv));
    await barrier(s);
    t = await ready(tm.token);
    t.send({ v: 1, id: "se", type: "sessions", open: ["rref"], closed: [] });
    await agent(t, "rref", rcv, n);
    const d = await waitFor(t, "deliver");
    expect(d.msg_id).toBe(r1.msg_id);
    // Resend after the flush, before the ack: pending, no second deliver.
    const r2 = (await reply(s, send("k1", "sref", rcv))) as Receipt;
    expect(r2).toMatchObject({ msg_id: r1.msg_id, state: "pending" });
    await barrier(t);
    expect(delivers(t)).toHaveLength(1);
    t.send({ v: 1, id: "a1", type: "ack", msg_id: d.msg_id });
    await waitFor(s, "receipt_update");
    const r3 = (await reply(s, send("k1", "sref", rcv))) as Receipt;
    expect(r3.msg_id).toBe(r1.msg_id);
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      msg_id: r1.msg_id,
      state: "delivered",
    });
    await barrier(t);
    expect(delivers(t)).toHaveLength(1);
    s.close();
    t.close();
  });

  it("P3 at the per-agent cap with every key pending: rate_limited, and the original still dedupes (one deliver)", async () => {
    const sm = await machine("S");
    const tm = await machine("T");
    const s = await ready(sm.token);
    let t = await ready(tm.token);
    const n = ns("adv14cap");
    const sender = uniq("Snd");
    await agent(s, "sref", sender, n);
    const rcvs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = uniq(`R${i}`);
      rcvs.push(r);
      await agent(t, `r${i}`, r, n);
    }
    await offline(t);
    await liftBudget(sm.id);
    // Original goes to R0 and stays pending (R0 offline).
    const first = (await reply(
      s,
      send("orig", "sref", rcvs[0] as string, "dup-me"),
    )) as Receipt;
    expect(first.state).toBe("pending");
    // 199 more accepted sends: the agent holds SEND_KEYS_PER_AGENT pending keys.
    for (let i = 0; i < SEND_KEYS_PER_AGENT - 1; i++) {
      const to = rcvs[1 + (i % 4)] as string;
      const r = (await reply(s, send(`f${i}`, "sref", to, "x"))) as Receipt;
      expect(r.state).toBe("pending");
    }
    const sid = await inOwnerHub(
      (st) =>
        st.storage.sql
          .exec<{ id: string }>(
            "select id from agents where machine_id = ? and native_ref = 'sref'",
            sm.id,
          )
          .one().id,
    );
    const counts = () =>
      inOwnerHub((st) => ({
        keys: st.storage.sql
          .exec<{ n: number }>(
            "select count(*) as n from send_keys where from_agent = ?",
            sid,
          )
          .one().n,
        receipts: st.storage.sql
          .exec<{ n: number }>(
            "select count(*) as n from receipts where from_agent = ?",
            sid,
          )
          .one().n,
      }));
    // No final key to evict: the next new send is rate_limited, nothing stored.
    const over = await reply(s, send("over", "sref", rcvs[4] as string, "x"));
    expect(over).toEqual({
      v: 1,
      id: "over",
      type: "error",
      code: "rate_limited",
      message: SEND_KEYS_MESSAGE,
    });
    expect(await counts()).toEqual({
      keys: SEND_KEYS_PER_AGENT,
      receipts: SEND_KEYS_PER_AGENT,
    });
    // The daemon resends the original (a lost connection): still deduped.
    const again = (await reply(
      s,
      send("orig", "sref", rcvs[0] as string, "dup-me"),
    )) as Receipt;
    expect(again).toMatchObject({ msg_id: first.msg_id, state: "pending" });
    t = await ready(tm.token);
    t.send({ v: 1, id: "se", type: "sessions", open: ["r0"], closed: [] });
    await agent(t, "r0", rcvs[0] as string, n);
    const d = await waitFor(t, "deliver");
    expect(d.msg_id).toBe(first.msg_id);
    await barrier(t);
    const ds = delivers(t).filter(
      (f) => f.type === "deliver" && "body" in f && f.body === "dup-me",
    );
    expect(ds.length).toBe(1);
    // Once one send is final, the oldest final key (orig) makes room.
    t.send({ v: 1, id: "a1", type: "ack", msg_id: d.msg_id });
    await waitFor(s, "receipt_update");
    const ok = (await reply(
      s,
      send("over", "sref", rcvs[0] as string, "x"),
    )) as Receipt;
    expect(ok.state).toBe("pending");
    expect((await counts()).keys).toBe(SEND_KEYS_PER_AGENT);
    const orig = (await reply(
      s,
      send("orig", "sref", rcvs[0] as string, "dup-me"),
    )) as Receipt;
    // orig's key was the one evicted (final): it is a new send now.
    expect(orig.msg_id).not.toBe(first.msg_id);
    s.close();
    t.close();
  }, 60_000);

  it("P4 sender closes and reopens (agent_down, agent_up same ref): key persists", async () => {
    const sm = await machine("S");
    const tm = await machine("T");
    const s = await ready(sm.token);
    const t = await ready(tm.token);
    const n = ns("adv14re");
    const sender = uniq("Snd");
    const rcv = uniq("Rcv");
    await agent(s, "sref", sender, n);
    await agent(t, "rref", rcv, n);
    const r1 = (await reply(s, send("k1", "sref", rcv))) as Receipt;
    await waitFor(t, "deliver");
    s.send({
      v: 1,
      id: "dn",
      type: "agent_down",
      agent_ref: "sref",
    } as ClientFrame);
    await barrier(s);
    await agent(s, "sref", sender, n);
    const r2 = (await reply(s, send("k1", "sref", rcv))) as Receipt;
    console.log("P4", r1.msg_id, r2.msg_id);
    expect(r2.msg_id).toBe(r1.msg_id);
    await barrier(t);
    expect(delivers(t)).toHaveLength(1);
    s.close();
    t.close();
  });

  it("P5 absent to_namespace vs the sender's own namespace (same target) is the same payload", async () => {
    const sm = await machine("S");
    const s = await ready(sm.token);
    const tm = await machine("T");
    const t = await ready(tm.token);
    const n = ns("adv14ns");
    const sender = uniq("Snd");
    const rcv = uniq("Rcv");
    await agent(s, "sref", sender, n);
    await agent(t, "rref", rcv, n);
    const r1 = await reply(s, send("k1", "sref", rcv));
    expect(r1.type).toBe("receipt");
    const r2 = await reply(s, send("k1", "sref", rcv, "hello", n));
    expect(r2).toEqual(r1);
    // And the other way round: explicit first, absent on the resend.
    const r3 = await reply(s, send("k2", "sref", rcv, "hello", n));
    const r4 = await reply(s, send("k2", "sref", rcv));
    expect(r4).toEqual(r3);
    await barrier(t);
    expect(delivers(t)).toHaveLength(2);
    s.close();
    t.close();
  });

  it("P6 recipient machine revoked while pending: resend reports expired, delivers nothing", async () => {
    const sm = await machine("S");
    const tm = await machine("T");
    const s = await ready(sm.token);
    const t = await ready(tm.token);
    const n = ns("adv14rv");
    const sender = uniq("Snd");
    const rcv = uniq("Rcv");
    await agent(s, "sref", sender, n);
    await agent(t, "rref", rcv, n);
    await offline(t);
    const r1 = (await reply(s, send("k1", "sref", rcv))) as Receipt;
    expect(await (await hubOf()).revokeMachine(tm.id)).toBe(true);
    await waitFor(s, "receipt_update");
    const r2 = (await reply(s, send("k1", "sref", rcv))) as Receipt;
    expect(r2).toMatchObject({ msg_id: r1.msg_id, state: "pending" });
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      msg_id: r1.msg_id,
      state: "expired",
      reason: "recipient_closed",
    });
    s.close();
  });

  it("P7 sender re-registers into another namespace: absent-ns resend dedupes to the old target", async () => {
    const sm = await machine("S");
    const tm = await machine("T");
    const s = await ready(sm.token);
    const t = await ready(tm.token);
    const n1 = ns("adv14a");
    const n2 = ns("adv14b");
    const sender = uniq("Snd");
    const bob = uniq("Bob");
    await agent(s, "sref", sender, n1);
    await agent(t, "b1", bob, n1);
    await agent(t, "b2", bob, n2);
    const r1 = (await reply(s, send("k1", "sref", bob))) as Receipt;
    await waitFor(t, "deliver");
    await agent(s, "sref", sender, n2);
    const r2 = (await reply(s, send("k1", "sref", bob))) as Receipt;
    console.log("P7", r1.msg_id, r2.msg_id, r2.state);
    expect(r2.msg_id).toBe(r1.msg_id);
    await barrier(t);
    expect(delivers(t)).toHaveLength(1);
    s.close();
    t.close();
  });

  it("P8 key older than 2 h while the receipt is still pending (#1295): still deduped, one deliver", async () => {
    const sm = await machine("S");
    const tm = await machine("T");
    const s = await ready(sm.token);
    let t = await ready(tm.token);
    const n = ns("adv14st");
    const sender = uniq("Snd");
    const rcv = uniq("Rcv");
    await agent(s, "sref", sender, n);
    await agent(t, "rref", rcv, n);
    await offline(t);
    const r1 = (await reply(s, send("k1", "sref", rcv, "stale"))) as Receipt;
    await setClock(Date.now() + 2 * LIMITS.mailTtlSec * 1000 + 5000);
    const r2 = (await reply(s, send("k1", "sref", rcv, "stale"))) as Receipt;
    console.log("P8", r1.msg_id, r2.msg_id, r2.state);
    expect(r2.msg_id).toBe(r1.msg_id);
    t = await ready(tm.token);
    t.send({ v: 1, id: "se", type: "sessions", open: ["rref"], closed: [] });
    await agent(t, "rref", rcv, n);
    await barrier(t);
    const ds = delivers(t);
    console.log("P8 delivers", ds.length);
    expect(ds).toHaveLength(1);
    s.close();
    t.close();
  });

  it("P9 hub-wide cap: ref churn cannot multiply the per-agent cap past SEND_KEYS_TOTAL", async () => {
    expect(SEND_KEYS_TOTAL).toBe(200_000);
    const sm = await machine("S");
    const tm = await machine("T");
    const s = await ready(sm.token);
    let t = await ready(tm.token);
    const n = ns("adv14ch");
    const rcv = uniq("Rcv");
    await agent(t, "rref", rcv, n);
    await offline(t);
    const total = () =>
      inOwnerHub(
        (st) =>
          st.storage.sql
            .exec<{ n: number }>("select count(*) as n from send_keys")
            .one().n,
      );
    // A clean slate and a small hub-wide cap (the rule, not the number).
    await inOwnerHub((st) => st.storage.sql.exec("delete from send_keys"));
    const CAP = 6;
    await inHub((i) => BusHub.setSendKeysTotalForTests(i, CAP));
    // Three refs (churned agents), two pending sends each: the hub is full.
    const ids: Receipt[] = [];
    for (let r = 0; r < 3; r++) {
      const ref = `churn${r}`;
      await agent(s, ref, uniq("C"), n);
      for (let i = 0; i < 2; i++) {
        const x = (await reply(
          s,
          send(`c${r}-${i}`, ref, rcv, `x${r}${i}`),
        )) as Receipt;
        expect(x.state).toBe("pending");
        ids.push(x);
      }
      s.send({
        v: 1,
        id: `d${r}`,
        type: "agent_down",
        agent_ref: ref,
      } as ClientFrame);
    }
    await barrier(s);
    expect(await total()).toBe(CAP);
    // A fresh ref: every key hub-wide is pending, so rate_limited.
    await agent(s, "churn9", uniq("C"), n);
    const over = await reply(s, send("c9", "churn9", rcv, "y"));
    expect(over).toMatchObject({
      type: "error",
      code: "rate_limited",
      message: SEND_KEYS_MESSAGE,
    });
    expect(await total()).toBe(CAP);
    // The recipient acks one (the second oldest): only that final key goes.
    t = await ready(tm.token);
    t.send({ v: 1, id: "se", type: "sessions", open: ["rref"], closed: [] });
    await agent(t, "rref", rcv, n);
    const target = (ids[1] as Receipt).msg_id;
    for (;;) {
      const d = await waitFor(t, "deliver");
      if (d.msg_id === target) {
        t.send({ v: 1, id: "a1", type: "ack", msg_id: d.msg_id });
        break;
      }
    }
    await waitFor(s, "receipt_update");
    const ok = (await reply(s, send("c9", "churn9", rcv, "y"))) as Receipt;
    expect(ok.state).toBe("pending");
    expect(await total()).toBe(CAP);
    const gone = await inOwnerHub((st) =>
      st.storage.sql
        .exec<{ msgId: string }>("select msg_id as msgId from send_keys")
        .toArray()
        .map((r) => r.msgId),
    );
    expect(gone).not.toContain(target);
    expect(gone).toContain((ids[0] as Receipt).msg_id);
    s.close();
    t.close();
  });
  it("hub-wide cap: 200 old pending keys and newer final ones: a new send evicts a final key, never refused", async () => {
    await inOwnerHub((st) => st.storage.sql.exec("delete from send_keys"));
    const sm = await machine("S");
    const tm = await machine("T");
    const am = await machine("A");
    const s = await ready(sm.token);
    const t = await ready(tm.token);
    const a = await ready(am.token);
    const n = ns("adv14hub");
    await agent(s, "old", uniq("Old"), n);
    await agent(s, "fresh", uniq("Fresh"), n);
    await agent(s, "new", uniq("New"), n);
    const sinks: string[] = [];
    for (let i = 0; i < 4; i++) {
      sinks.push(uniq(`Sink${i}`));
      await agent(t, `k${i}`, sinks[i] as string, n);
    }
    const acker = uniq("Acker");
    await agent(a, "acker", acker, n);
    await offline(t);
    await liftBudget(sm.id);
    // SEND_KEYS_PER_AGENT old keys, all pending (the recipients are offline).
    for (let i = 0; i < SEND_KEYS_PER_AGENT; i++) {
      const r = (await reply(
        s,
        send(`o${i}`, "old", sinks[i % 4] as string, "x"),
      )) as Receipt;
      expect(r.state).toBe("pending");
    }
    // Then newer keys whose sends are delivered (final).
    const fresh: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = (await reply(s, send(`f${i}`, "fresh", acker, "y"))) as Receipt;
      fresh.push(r.msg_id);
      const d = await waitFor(a, "deliver");
      a.send({ v: 1, id: `a${i}`, type: "ack", msg_id: d.msg_id });
      for (;;)
        if ((await waitFor(s, "receipt_update")).msg_id === r.msg_id) break;
    }
    const keys = () =>
      inOwnerHub((st) =>
        st.storage.sql
          .exec<{ msgId: string; final: number }>(
            "select msg_id as msgId, final from send_keys",
          )
          .toArray(),
      );
    const before = await keys();
    expect(before).toHaveLength(SEND_KEYS_PER_AGENT + 3);
    expect(
      before
        .filter((k) => k.final === 1)
        .map((k) => k.msgId)
        .sort(),
    ).toEqual([...fresh].sort());
    // The hub is full: the oldest SEND_KEYS_PER_AGENT keys are all pending.
    await inHub((i) =>
      BusHub.setSendKeysTotalForTests(i, SEND_KEYS_PER_AGENT + 3),
    );
    const ok = await reply(s, send("n1", "new", acker, "z"));
    expect(ok).toMatchObject({ type: "receipt", state: "pending" });
    const after = await keys();
    expect(after).toHaveLength(SEND_KEYS_PER_AGENT + 3);
    expect(after.map((k) => k.msgId)).not.toContain(fresh[0]);
    expect(after.filter((k) => k.final === 0)).toHaveLength(
      SEND_KEYS_PER_AGENT + 1,
    );
    s.close();
    a.close();
  }, 60_000);

  describe("every path that finalizes a receipt marks its key final", () => {
    const keyFinal = (msgId: string) =>
      inOwnerHub(
        (st) =>
          st.storage.sql
            .exec<{ final: number }>(
              "select final from send_keys where msg_id = ?",
              msgId,
            )
            .one().final,
      );
    const runAlarm = async () => {
      for (let i = 0; i < 20; i++) {
        await runDurableObjectAlarm(await stub());
      }
    };
    async function pair(offlineRecipient = false) {
      const sm = await machine("S");
      const tm = await machine("T");
      const s = await ready(sm.token);
      const t = await ready(tm.token);
      const n = ns("adv14fin");
      const rcv = uniq("Rcv");
      await agent(s, "sref", uniq("Snd"), n);
      await agent(t, "rref", rcv, n);
      if (offlineRecipient) await offline(t);
      const r = (await reply(s, send("k1", "sref", rcv))) as Receipt;
      expect(r.state).toBe("pending");
      expect(await keyFinal(r.msg_id)).toBe(0);
      const told = async (state: string) => {
        for (;;) {
          const u = await waitFor(s, "receipt_update");
          if (u.msg_id === r.msg_id) {
            expect(u.state).toBe(state);
            return;
          }
        }
      };
      return {
        s,
        t,
        tm,
        r,
        told,
        close: () => {
          for (const d of [s, t])
            try {
              d.close();
            } catch {
              // Already closed.
            }
        },
      };
    }

    it("ack (settle delivered)", async () => {
      const { t, r, told, close } = await pair();
      await waitFor(t, "deliver");
      t.send({ v: 1, id: "a1", type: "ack", msg_id: r.msg_id });
      await told("delivered");
      expect(await keyFinal(r.msg_id)).toBe(1);
      close();
    });

    it("refuse (settle refused: closed)", async () => {
      const { t, r, told, close } = await pair();
      await waitFor(t, "deliver");
      t.send({
        v: 1,
        id: "x1",
        type: "refuse",
        msg_id: r.msg_id,
        reason: "closed",
        detail: "denied",
      } as ClientFrame);
      await told("refused");
      expect(await keyFinal(r.msg_id)).toBe(1);
      close();
    });

    it("TTL expiry", async () => {
      const { r, told, close } = await pair(true);
      // The key of pending mail is never swept by age, and a final key only
      // past 2 h: pull the expiry in so the TTL step (not the sweep) runs.
      await inOwnerHub((st) =>
        st.storage.sql.exec(
          "update receipts set expires_at = ? where id = ?",
          Date.now() + 500,
          r.msg_id,
        ),
      );
      await setClock(Date.now() + LIMITS.mailTtlSec * 1000 + 1000);
      await runAlarm();
      await told("expired");
      expect(await keyFinal(r.msg_id)).toBe(1);
      close();
    });

    it("lost body (eviction past the ack timeout)", async () => {
      const { t, r, told, close } = await pair();
      await waitFor(t, "deliver");
      await inHub((i) => BusHub.dropHeldForTests(i));
      await setClock(Date.now() + LIMITS.ackTimeoutMs + 1000);
      await runAlarm();
      await told("expired");
      expect(await keyFinal(r.msg_id)).toBe(1);
      close();
    });

    it("close (the recipient's session ends) keeps the mail and its key pending (#1295); the TTL then finalizes it", async () => {
      const { t, r, told, close } = await pair();
      await waitFor(t, "deliver");
      t.send({
        v: 1,
        id: "dn",
        type: "agent_down",
        agent_ref: "rref",
      } as ClientFrame);
      await barrier(t);
      expect(await keyFinal(r.msg_id)).toBe(0);
      await inOwnerHub((st) =>
        st.storage.sql.exec(
          "update receipts set expires_at = ? where id = ?",
          Date.now() + 500,
          r.msg_id,
        ),
      );
      await setClock(Date.now() + LIMITS.mailTtlSec * 1000 + 1000);
      await runAlarm();
      await told("expired");
      expect(await keyFinal(r.msg_id)).toBe(1);
      close();
    });

    it("revoke (the recipient's machine)", async () => {
      const { tm, r, told, close } = await pair(true);
      expect(await (await hubOf()).revokeMachine(tm.id)).toBe(true);
      await told("expired");
      expect(await keyFinal(r.msg_id)).toBe(1);
      close();
    });
  });

  it("migrateHub adds final and backfills it from receipts", async () => {
    const tag = uniq("bf");
    const rows = await inOwnerHub((st) => {
      const sql = st.storage.sql;
      sql.exec("drop index if exists send_keys_final");
      sql.exec("drop index if exists send_keys_agent_final");
      sql.exec("drop index if exists send_keys_msg");
      sql.exec("alter table send_keys drop column final");
      const receipt = (id: string, state: string) =>
        sql.exec(
          `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at)
           values (?, 'o', 'n', 'x', 'x', ?, 'x', ?, 1, 0, 0)`,
          id,
          tag,
          state,
        );
      receipt(`${tag}p`, "pending");
      receipt(`${tag}d`, "delivered");
      for (const m of ["p", "d", "gone"])
        sql.exec(
          `insert into send_keys (from_agent, frame_id, org_id, payload_hash, msg_id, created_at)
           values (?, ?, 'o', 'h', ?, ?)`,
          tag,
          m,
          `${tag}${m}`,
          Date.now(),
        );
      migrateHub(sql);
      const out = sql
        .exec<{ frame: string; final: number }>(
          "select frame_id as frame, final from send_keys where from_agent = ? order by frame_id",
          tag,
        )
        .toArray();
      const idx = sql
        .exec<{ name: string }>(
          "select name from sqlite_master where type = 'index' and name in ('send_keys_final', 'send_keys_agent_final', 'send_keys_msg')",
        )
        .toArray()
        .map((r) => r.name)
        .sort();
      sql.exec("delete from send_keys where from_agent = ?", tag);
      sql.exec("delete from receipts where from_agent = ?", tag);
      return { out, idx };
    });
    expect(rows.out).toEqual([
      { frame: "d", final: 1 },
      { frame: "gone", final: 1 },
      { frame: "p", final: 0 },
    ]);
    expect(rows.idx).toEqual([
      "send_keys_agent_final",
      "send_keys_final",
      "send_keys_msg",
    ]);
  });
});
