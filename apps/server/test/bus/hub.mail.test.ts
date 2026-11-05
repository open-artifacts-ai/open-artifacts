// Ported from OpenBus v0.63.0 apps/server/test/hub.mail.test.ts (#1291).
// Dropped: nothing.
// B6: send, inline delivery, notice, ack, refuse, receipts and write-on-miss.
// Every frame a daemon receives is checked with decodeServerFrame (helpers.ts).
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  type ClientFrame,
  LIMITS,
  MAILBOX_PENDING_CAP,
  type RefusalReason,
  type ServerFrame,
} from "@oa/bus-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BusHub, HELD_BYTES_CAP } from "../../src/bus/hub.js";
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

/** The hub's in-memory held bodies (test-only static accessor). */
const heldStats = async () =>
  runInDurableObject(await hubOf(), (i: BusHub) => BusHub.heldStats(i));

// #1295: a close no longer releases held mail (it stays pending for the
// reopen), so a test's leftovers must not fill the shared held cap.
afterEach(async () => {
  await runInDurableObject(await hubOf(), (i: BusHub) =>
    BusHub.dropHeldForTests(i),
  );
});

/**
 * #1295: a closed agent keeps its name (`away`) and mail is accepted for it
 * until the reservation ends; this ends every reservation, so the name
 * reads as closed.
 */
const endAway = async () =>
  inOwnerHub((st) => {
    st.storage.sql.exec(
      "update former_names set expires_at = 1 where kind = 'away'",
    );
  });

type Receipt = Extract<ServerFrame, { type: "receipt" }>;
type Deliver = Extract<ServerFrame, { type: "deliver" }>;

let seq = 0;
/** A bus name no other test uses (global names are unique across namespaces). */
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;

const send = (
  id: string,
  from_ref: string,
  to_name: string,
  body = "hello",
  to_namespace?: string,
): ClientFrame =>
  to_namespace === undefined
    ? { v: 1, id, type: "send", from_ref, to_name, body }
    : { v: 1, id, type: "send", from_ref, to_name, to_namespace, body };

const ack = (id: string, msg_id: string): ClientFrame => ({
  v: 1,
  id,
  type: "ack",
  msg_id,
});
const refuse = (id: string, msg_id: string): ClientFrame => ({
  v: 1,
  id,
  type: "refuse",
  msg_id,
  reason: "closed",
  detail: "denied",
});

/** Registers an agent and checks it got exactly the name asked for. */
async function agent(
  d: Daemon,
  ref: string,
  name: string,
  namespace: string,
  global = false,
): Promise<void> {
  d.send(up(`u-${ref}`, ref, name, namespace, global));
  expect((await waitFor(d, "agent_ok")).bus_name).toBe(name);
}

async function down(d: Daemon, ref: string): Promise<void> {
  d.send({ v: 1, id: "dn", type: "agent_down", agent_ref: ref });
  await barrier(d);
}

/** Frames on one socket are handled in order: once hello_ok is back, all earlier frames were. */
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

type Row = { state: string; reason: string | null; ackedAt: number | null };
const receiptRow = (id: string) =>
  inOwnerHub(
    (s) =>
      s.storage.sql
        .exec<Row>(
          "select state, reason, acked_at as ackedAt from receipts where id = ?",
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
const receiptCount = () =>
  inOwnerHub(
    (s) =>
      s.storage.sql
        .exec<{ n: number }>("select count(*) as n from receipts")
        .one().n,
  );

/** Two machines on two sockets: S hosts the senders, T the targets. */
async function pair() {
  const sm = await machine("Sender");
  const tm = await machine("Target");
  const s = await ready(sm.token);
  const t = await ready(tm.token);
  const close = () => {
    for (const d of [s, t])
      try {
        d.close();
      } catch {
        // Already closed by the test.
      }
  };
  return { s, t, sm, tm, close };
}

const types = (d: Daemon) => framesSeen(d).map((f) => f.type);

describe("mail: delivery", () => {
  it("delivers inline, acks, and reports delivered", async () => {
    const { s, t, close } = await pair();
    const n = ns();
    const sender = uniq("Sender");
    const receiver = uniq("Receiver");
    await agent(s, "sref", sender, n);
    await agent(t, "rref", receiver, n);

    const receipt = await sendAndReceipt(s, send("s1", "sref", receiver));
    expect(receipt).toMatchObject({ id: "s1", state: "pending" });
    expect(receipt.reason).toBeUndefined();

    const deliver = await waitFor(t, "deliver");
    expect(deliver).toMatchObject({
      msg_id: receipt.msg_id,
      to_ref: "rref",
      from_name: sender,
      namespace: n,
      body: "hello",
    });
    expect(deliver.notice).toBeUndefined();
    // The receipt row was written before the push; the body is held in memory.
    expect(await receiptRow(receipt.msg_id)).toMatchObject({
      state: "pending",
      ackedAt: null,
    });
    expect(await mailRow(receipt.msg_id)).toBeNull();

    t.send(ack("a1", deliver.msg_id));
    const upd = await waitFor(s, "receipt_update");
    expect(upd).toMatchObject({ msg_id: receipt.msg_id, state: "delivered" });
    expect(upd.reason).toBeUndefined();
    const row = await receiptRow(receipt.msg_id);
    expect(row?.state).toBe("delivered");
    expect(row?.ackedAt).toEqual(expect.any(Number));
    close();
  });

  it("targets names case-insensitively", async () => {
    const { s, t, close } = await pair();
    const n = ns();
    const alice = uniq("Alice");
    await agent(s, "sref", uniq("Sender"), n);
    await agent(t, "rref", alice, n);
    const r = await sendAndReceipt(s, send("s1", "sref", alice.toUpperCase()));
    expect(r.state).toBe("pending");
    expect((await waitFor(t, "deliver")).to_ref).toBe("rref");
    close();
  });

  it("deliver.namespace is the sender's namespace", async () => {
    const { s, t, close } = await pair();
    const mine = ns("mine");
    const theirs = ns("theirs");
    const g = uniq("Glob");
    await agent(s, "sref", uniq("Sender"), mine);
    await agent(t, "gref", g, theirs, true);
    expect((await sendAndReceipt(s, send("s1", "sref", g))).state).toBe(
      "pending",
    );
    expect((await waitFor(t, "deliver")).namespace).toBe(mine);
    close();
  });

  it("sends an oversized body as a notice and persists it", async () => {
    const { s, t, close } = await pair();
    const n = ns();
    const receiver = uniq("Receiver");
    await agent(s, "sref", uniq("Sender"), n);
    await agent(t, "rref", receiver, n);

    const big = "é".repeat(LIMITS.inlineBodyBytes / 2 + 1); // 2 bytes each
    const r = await sendAndReceipt(s, send("s1", "sref", receiver, big));
    expect(r.state).toBe("pending");
    const deliver = await waitFor(t, "deliver");
    expect(deliver.body).toBeUndefined();
    expect(deliver.notice).toEqual({
      size: LIMITS.inlineBodyBytes + 2,
      msg_id: deliver.msg_id,
    });
    expect((await mailRow(r.msg_id))?.body).toBe(big);

    // The harness accepted the notice: delivered. The body stays stored
    // until it is fetched (B8) or expires (B7).
    t.send(ack("a1", deliver.msg_id));
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      msg_id: r.msg_id,
      state: "delivered",
    });
    expect(await receiptRow(r.msg_id)).toMatchObject({ state: "delivered" });
    expect((await mailRow(r.msg_id))?.body).toBe(big);
    close();
  });

  it("rejects a body over the hard cap in the decoder, with no receipt", async () => {
    const m = await machine();
    const d = await ready(m.token);
    const me = uniq("Me");
    await agent(d, "sref", me, ns());
    const before = await receiptCount();
    d.send(send("s2", "sref", me, "x".repeat(LIMITS.maxMessageBytes + 1)));
    expect(await waitFor(d, "error")).toMatchObject({
      id: "s2",
      code: "too_large",
    });
    expect(await receiptCount()).toBe(before);
    expect(types(d)).not.toContain("receipt");
    d.close();
  });

  it("queues for a live agent whose machine is offline: mail stored, receipt pending, no deliver", async () => {
    const { s, t, close } = await pair();
    const n = ns();
    const receiver = uniq("Receiver");
    await agent(s, "sref", uniq("Sender"), n);
    await agent(t, "rref", receiver, n);
    t.close();
    await t.closed;
    await new Promise((r) => setTimeout(r, 50));

    const r = await sendAndReceipt(s, send("s1", "sref", receiver, "later"));
    expect(r.state).toBe("pending");
    expect(await receiptRow(r.msg_id)).toMatchObject({ state: "pending" });
    expect((await mailRow(r.msg_id))?.body).toBe("later");
    await barrier(s);
    expect(types(s)).not.toContain("deliver");
    expect(types(t)).not.toContain("deliver");
    close();
  });

  it("never delivers to a replaced socket", async () => {
    const sm = await machine("Sender");
    const tm = await machine("Target");
    const s = await ready(sm.token);
    const old = await ready(tm.token);
    const n = ns();
    const receiver = uniq("Receiver");
    await agent(s, "sref", uniq("Sender"), n);
    await agent(old, "rref", receiver, n);
    const fresh = await ready(tm.token); // replaces `old`

    const r = await sendAndReceipt(s, send("s1", "sref", receiver));
    expect(r.state).toBe("pending");
    expect((await waitFor(fresh, "deliver")).msg_id).toBe(r.msg_id);
    expect(types(old)).not.toContain("deliver");
    s.close();
    fresh.close();
  });

  it("self-send behaves like any other send", async () => {
    const m = await machine();
    const d = await ready(m.token);
    const n = ns();
    const me = uniq("Me");
    await agent(d, "sref", me, n);
    const r = await sendAndReceipt(d, send("s1", "sref", me, "note to self"));
    expect(r.state).toBe("pending");
    const deliver = await waitFor(d, "deliver");
    expect(deliver).toMatchObject({
      msg_id: r.msg_id,
      to_ref: "sref",
      from_name: me,
      namespace: n,
      body: "note to self",
    });
    d.send(ack("a1", deliver.msg_id));
    expect(await waitFor(d, "receipt_update")).toMatchObject({
      msg_id: r.msg_id,
      state: "delivered",
    });
    d.close();
  });
});

describe("mail: refusals", () => {
  it("refuses an unknown agent with a fresh msg_id and stores nothing", async () => {
    const m = await machine();
    const d = await ready(m.token);
    await agent(d, "sref", uniq("Sender"), ns());
    const before = await receiptCount();
    const r = await sendAndReceipt(d, send("s1", "sref", uniq("Nobody")));
    expect(r).toMatchObject({
      id: "s1",
      state: "refused",
      reason: "unknown_agent",
    });
    expect(r.msg_id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{16}$/);
    expect(await receiptCount()).toBe(before);
    expect(await receiptRow(r.msg_id)).toBeNull();
    d.close();
  });

  it("refuses the message past the inbox cap", async () => {
    const { s, t, close } = await pair();
    const n = ns();
    const receiver = uniq("Receiver");
    await agent(s, "sref", uniq("Sender"), n);
    // Registered, then the machine goes offline: the agent stays live and queues.
    await agent(t, "rref", receiver, n);
    t.close();
    await t.closed;

    for (let i = 0; i < MAILBOX_PENDING_CAP; i++)
      expect(
        (await sendAndReceipt(s, send(`q${i}`, "sref", receiver, `m${i}`)))
          .state,
      ).toBe("pending");
    const before = await receiptCount();
    expect(
      await sendAndReceipt(s, send("over", "sref", receiver, "one too many")),
    ).toMatchObject({ state: "refused", reason: "inbox_full" });
    expect(await receiptCount()).toBe(before);
    close();
  });
});

describe("mail: ack and refuse", () => {
  async function delivered() {
    const p = await pair();
    const n = ns();
    const receiver = uniq("Receiver");
    await agent(p.s, "sref", uniq("Sender"), n);
    await agent(p.t, "rref", receiver, n);
    const r = await sendAndReceipt(p.s, send("s1", "sref", receiver, "hi"));
    const deliver = await waitFor(p.t, "deliver");
    expect(deliver.msg_id).toBe(r.msg_id);
    return { ...p, n, receiver, msgId: r.msg_id };
  }

  it("turns a harness refusal into refused:closed; a later ack cannot resurrect it", async () => {
    const { s, t, msgId, receiver, close } = await delivered();
    t.send(refuse("r1", msgId));
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      msg_id: msgId,
      state: "refused",
      reason: "closed",
    });
    expect(await receiptRow(msgId)).toMatchObject({
      state: "refused",
      reason: "closed",
    });
    expect(await mailRow(msgId)).toBeNull();

    t.send(ack("a1", msgId));
    t.send(refuse("r2", msgId));
    await barrier(t);
    expect(await receiptRow(msgId)).toMatchObject({
      state: "refused",
      reason: "closed",
      ackedAt: null,
    });
    // The next send works, and the sender heard exactly one update.
    expect((await sendAndReceipt(s, send("s2", "sref", receiver))).state).toBe(
      "pending",
    );
    expect(types(s).filter((x) => x === "receipt_update")).toHaveLength(1);
    close();
  });

  it("ignores ack and refuse from any machine but the recipient's", async () => {
    const { s, t, msgId, close } = await delivered();
    const om = await machine("Other");
    const o = await ready(om.token);
    await agent(o, "oref", uniq("Other"), ns());
    o.send(ack("a1", msgId));
    o.send(refuse("r1", msgId));
    await barrier(o);
    // The sender's machine is not the recipient's either.
    s.send(ack("a2", msgId));
    s.send(refuse("r2", msgId));
    await barrier(s);
    expect(await receiptRow(msgId)).toMatchObject({ state: "pending" });
    expect(types(s)).not.toContain("receipt_update");
    expect(types(o)).not.toContain("receipt_update");

    t.send(ack("a3", msgId));
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      msg_id: msgId,
      state: "delivered",
    });
    o.close();
    close();
  });

  it("ignores an ack for an unknown message", async () => {
    const m = await machine();
    const d = await ready(m.token);
    d.send(ack("a1", "1111111111111111"));
    d.send(refuse("r1", "1111111111111111"));
    await barrier(d);
    expect(types(d)).toEqual(["hello_ok", "hello_ok"]);
    d.close();
  });
});

// ------------------------------------------------------- resolution matrix

type Outcome = "deliver" | RefusalReason;

describe("mail: target resolution", () => {
  /** S hosts the sender; T hosts targets. Returns the outcome of one send. */
  async function outcome(
    s: Daemon,
    t: Daemon,
    from: string,
    to: string,
    toNs?: string,
  ): Promise<{ outcome: Outcome; receipt: Receipt; deliver?: Deliver }> {
    const id = `s${++seq}`;
    const receipt = await sendAndReceipt(s, send(id, from, to, "x", toNs));
    if (receipt.state === "pending") {
      const deliver = await waitFor(t, "deliver");
      expect(deliver.msg_id).toBe(receipt.msg_id);
      return { outcome: "deliver", receipt, deliver };
    }
    expect(receipt.state).toBe("refused");
    return { outcome: receipt.reason as RefusalReason, receipt };
  }

  describe("1. non-global sender, no to_namespace (or its own)", () => {
    it("own namespace first, then live globals", async () => {
      const { s, t, close } = await pair();
      const mine = ns("mine");
      const other = ns("other");
      const local = uniq("Local");
      const g = uniq("Glob");
      await agent(s, "sref", uniq("Sender"), mine);
      await agent(t, "lref", local, mine);
      await agent(t, "gref", g, other, true);

      const a = await outcome(s, t, "sref", local);
      expect(a.outcome).toBe("deliver");
      expect(a.deliver?.to_ref).toBe("lref");
      const b = await outcome(s, t, "sref", g);
      expect(b.outcome).toBe("deliver");
      expect(b.deliver?.to_ref).toBe("gref");
      // to_namespace equal to its own is a no-op.
      const c = await outcome(s, t, "sref", local, mine);
      expect(c.deliver?.to_ref).toBe("lref");
      const d = await outcome(s, t, "sref", g, mine);
      expect(d.deliver?.to_ref).toBe("gref");
      close();
    });

    it("closed in its namespace or as a global is closed", async () => {
      const { s, t, close } = await pair();
      const mine = ns("mine");
      const local = uniq("Local");
      const g = uniq("Glob");
      await agent(s, "sref", uniq("Sender"), mine);
      await agent(t, "lref", local, mine);
      await agent(t, "gref", g, ns("other"), true);
      await down(t, "lref");
      await down(t, "gref");
      await endAway();
      expect((await outcome(s, t, "sref", local)).outcome).toBe("closed");
      expect((await outcome(s, t, "sref", g)).outcome).toBe("closed");
      close();
    });

    it("live only in another namespace is unknown_agent (invisible); closed in its own wins", async () => {
      const { s, t, close } = await pair();
      const mine = ns("mine");
      const other = ns("other");
      const far = uniq("Far");
      const both = uniq("Both");
      await agent(s, "sref", uniq("Sender"), mine);
      await agent(t, "fref", far, other);
      expect((await outcome(s, t, "sref", far)).outcome).toBe("unknown_agent");
      await agent(t, "b1", both, mine);
      await down(t, "b1");
      await agent(t, "b2", both, other);
      await endAway();
      expect((await outcome(s, t, "sref", both)).outcome).toBe("closed");
      close();
    });

    it("nothing by that name is unknown_agent", async () => {
      const { s, t, close } = await pair();
      await agent(s, "sref", uniq("Sender"), ns());
      expect((await outcome(s, t, "sref", uniq("Ghost"))).outcome).toBe(
        "unknown_agent",
      );
      close();
    });
  });

  describe("2. non-global sender, to_namespace X other than its own", () => {
    it("reaches a live global in X", async () => {
      const { s, t, close } = await pair();
      const x = ns("x");
      const g = uniq("Glob");
      await agent(s, "sref", uniq("Sender"), ns("mine"));
      await agent(t, "gref", g, x, true);
      const r = await outcome(s, t, "sref", g, x);
      expect(r.outcome).toBe("deliver");
      expect(r.deliver?.to_ref).toBe("gref");
      close();
    });

    it("refuses a global whose home namespace is not X", async () => {
      const { s, t, close } = await pair();
      const g = uniq("Glob");
      await agent(s, "sref", uniq("Sender"), ns("mine"));
      await agent(t, "gref", g, ns("y"), true);
      const r = await outcome(s, t, "sref", g, ns("x"));
      expect(r.outcome).toBe("other_namespace");
      // Without to_namespace (or with its own) the global is reachable.
      expect((await outcome(s, t, "sref", g)).deliver?.to_ref).toBe("gref");
      expect(types(t).filter((x) => x === "deliver")).toHaveLength(1);
      close();
    });

    it("refuses everything else other_namespace, identically whether or not the name exists in X", async () => {
      const { s, t, close } = await pair();
      const mine = ns("mine");
      const x = ns("x");
      const real = uniq("Real");
      const closedG = uniq("GoneGlob");
      await agent(s, "sref", uniq("Sender"), mine);
      await agent(t, "rref", real, x); // live, non-global, in X
      await agent(t, "cg", closedG, x, true);
      await down(t, "cg");

      const exists = await outcome(s, t, "sref", real, x);
      const missing = await outcome(s, t, "sref", uniq("Ghost"), x);
      const closed = await outcome(s, t, "sref", closedG, x);
      // A name live in the sender's own namespace is not reachable via X either.
      const localOnly = uniq("Local");
      await agent(t, "lref", localOnly, mine);
      const local = await outcome(s, t, "sref", localOnly, x);

      const shape = (r: Receipt) => {
        const { id: _i, msg_id: _m, ...rest } = r;
        return rest;
      };
      for (const r of [exists, missing, closed, local]) {
        expect(r.outcome).toBe("other_namespace");
        expect(shape(r.receipt)).toEqual(shape(missing.receipt));
        expect(Object.keys(r.receipt).sort()).toEqual(
          Object.keys(missing.receipt).sort(),
        );
      }
      expect(types(t)).not.toContain("deliver");
      close();
    });
  });

  describe("3. global sender with to_namespace X", () => {
    it("live in X delivers, closed is closed, neither is unknown_agent", async () => {
      const { s, t, close } = await pair();
      const x = ns("x");
      const live = uniq("Live");
      const gone = uniq("Gone");
      await agent(s, "gs", uniq("GSender"), ns("home"), true);
      await agent(t, "lref", live, x);
      await agent(t, "cref", gone, x);
      await down(t, "cref");
      await endAway();
      const a = await outcome(s, t, "gs", live, x);
      expect(a.outcome).toBe("deliver");
      expect(a.deliver?.to_ref).toBe("lref");
      expect((await outcome(s, t, "gs", gone, x)).outcome).toBe("closed");
      expect((await outcome(s, t, "gs", uniq("Ghost"), x)).outcome).toBe(
        "unknown_agent",
      );
      // The name live elsewhere but not in X does not resolve in X.
      const elsewhere = uniq("Else");
      await agent(t, "eref", elsewhere, ns("y"));
      expect((await outcome(s, t, "gs", elsewhere, x)).outcome).toBe(
        "unknown_agent",
      );
      close();
    });
  });

  describe("4. global sender without to_namespace", () => {
    it("a live global, or exactly one live match anywhere, delivers", async () => {
      const { s, t, close } = await pair();
      const g = uniq("Glob");
      const one = uniq("Solo");
      await agent(s, "gs", uniq("GSender"), ns("home"), true);
      await agent(t, "gref", g, ns("a"), true);
      await agent(t, "oref", one, ns("b"));
      expect((await outcome(s, t, "gs", g)).deliver?.to_ref).toBe("gref");
      expect((await outcome(s, t, "gs", one)).deliver?.to_ref).toBe("oref");
      close();
    });

    it("two or more live matches is ambiguous", async () => {
      const { s, t, close } = await pair();
      const twin = uniq("Twin");
      await agent(s, "gs", uniq("GSender"), ns("home"), true);
      await agent(t, "t1", twin, ns("a"));
      await agent(t, "t2", twin.toUpperCase(), ns("b"));
      expect((await outcome(s, t, "gs", twin)).outcome).toBe("ambiguous");
      expect(types(t)).not.toContain("deliver");
      close();
    });

    it("none live: closed if a closed match exists, else unknown_agent", async () => {
      const { s, t, close } = await pair();
      const gone = uniq("Gone");
      await agent(s, "gs", uniq("GSender"), ns("home"), true);
      await agent(t, "cref", gone, ns("a"));
      await down(t, "cref");
      await endAway();
      expect((await outcome(s, t, "gs", gone)).outcome).toBe("closed");
      expect((await outcome(s, t, "gs", uniq("Ghost"))).outcome).toBe(
        "unknown_agent",
      );
      close();
    });
  });
});

describe("mail: held memory", () => {
  /** Sends `n` frames, then collects their receipts (one round trip per batch). */
  async function burst(d: Daemon, frames: ClientFrame[]): Promise<Receipt[]> {
    for (const f of frames) d.send(f);
    const out: Receipt[] = [];
    while (out.length < frames.length) out.push(await waitFor(d, "receipt"));
    return out;
  }

  // 300 x 32 KB = 9.4 MiB, just past HELD_BYTES_CAP: the smallest load that
  // proves the cap (the adversarial probe used 5000).
  it("300 unacked 32 KB inline sends stay under the held cap and lose nothing", async () => {
    expect(6 * LIMITS.inboxCap * LIMITS.inlineBodyBytes).toBeGreaterThan(
      HELD_BYTES_CAP,
    );
    const { s, t, close } = await pair();
    const n = ns();
    await agent(s, "sref", uniq("Sender"), n);
    const body = "y".repeat(LIMITS.inlineBodyBytes);
    const ids: string[] = [];
    const refs: string[] = [];
    for (let a = 0; a < 6; a++) {
      const name = uniq(`R${a}`);
      await agent(t, `r${a}`, name, n);
      refs.push(`r${a}`);
      // One sender agent per batch: B14 caps an agent's pending sends.
      await agent(s, `sref${a}`, uniq(`Sender${a}`), n);
      const rs = await burst(
        s,
        Array.from({ length: LIMITS.inboxCap }, (_, i) =>
          send(`s${a}x${i}`, `sref${a}`, name, body),
        ),
      );
      for (const r of rs) {
        expect(r.state).toBe("pending");
        ids.push(r.msg_id);
      }
      // Every push still goes out inline, held or not. Drained per batch so
      // the test's own memory stays small.
      for (const r of rs) {
        const d = await waitFor(t, "deliver");
        expect(d.msg_id).toBe(r.msg_id);
        expect(d.body?.length).toBe(body.length);
      }
      t.raw.length = 0;
      s.raw.length = 0;
      expect((await heldStats()).bytes).toBeLessThanOrEqual(HELD_BYTES_CAP);
    }

    // Nothing lost: each body is held in memory or stored in mail.
    const held = new Set((await heldStats()).ids);
    expect(held.size).toBeGreaterThan(0);
    expect(held.size).toBeLessThan(ids.length); // some spilled past the cap
    const stored = await inOwnerHub(
      (st) =>
        new Set(
          st.storage.sql
            .exec<{ id: string }>("select id from mail")
            .toArray()
            .map((r) => r.id),
        ),
    );
    for (const id of ids) expect(held.has(id) || stored.has(id)).toBe(true);

    // #1295: recipients going down keep their mail pending (away); the
    // close drain only drops delivered notice bodies, so nothing is lost.
    for (const ref of refs)
      t.send({ v: 1, id: "dn", type: "agent_down", agent_ref: ref });
    await barrier(t);
    for (let k = 0; k < 100; k++) {
      const queued = await inOwnerHub(
        (st) =>
          st.storage.sql
            .exec("select 1 from meta where key like 'close_drain:%' limit 1")
            .toArray().length,
      );
      if (queued === 0) break;
      await runDurableObjectAlarm(await hubOf());
      await new Promise((r) => setTimeout(r, 5));
    }
    const after = new Set((await heldStats()).ids);
    const stored2 = await inOwnerHub(
      (st) =>
        new Set(
          st.storage.sql
            .exec<{ id: string }>("select id from mail")
            .toArray()
            .map((r) => r.id),
        ),
    );
    for (const id of ids) expect(after.has(id) || stored2.has(id)).toBe(true);
    for (const id of ids.slice(0, 3))
      expect(await receiptRow(id)).toMatchObject({ state: "pending" });
    close();
  });

  it("sessions{closed} keeps a closed agent's held mail pending (#1295); a late inline ack from its machine still settles it", async () => {
    const { s, t, close } = await pair();
    const n = ns();
    const receiver = uniq("Receiver");
    await agent(s, "sref", uniq("Sender"), n);
    await agent(t, "rref", receiver, n);
    const r = await sendAndReceipt(s, send("s1", "sref", receiver, "held"));
    await waitFor(t, "deliver");
    expect((await heldStats()).ids).toContain(r.msg_id);
    expect(await mailRow(r.msg_id)).toBeNull();
    t.send({ v: 1, id: "c1", type: "sessions", open: [], closed: ["rref"] });
    await barrier(t);
    expect(await receiptRow(r.msg_id)).toMatchObject({ state: "pending" });
    expect((await heldStats()).ids).toContain(r.msg_id);
    t.send(ack("a1", r.msg_id));
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      msg_id: r.msg_id,
      state: "delivered",
    });
    close();
  });
});
