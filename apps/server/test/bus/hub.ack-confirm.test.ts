// #2198: a mail ack from a socket that listed ack_confirm is answered with
// `acked {msg_id}` once the hub settled the receipt, or at once for an id
// that can no longer settle (repeat, unknown, not this machine's), always
// with the same frame. A socket without the cap hears nothing.
import { BUS_CAPS, type ClientFrame, type ServerFrame } from "@oa/bus-protocol";
import { describe, expect, it } from "vitest";
import {
  type Daemon,
  daemon,
  framesSeen,
  hello,
  inOwnerHub,
  machine,
  ns,
  up,
  waitFor,
} from "./helpers.js";

let seq = 0;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;
type Receipt = Extract<ServerFrame, { type: "receipt" }>;

async function open(token: string, caps: string[]): Promise<Daemon> {
  const d = await daemon(token);
  d.send({ ...hello("h0"), caps } as ClientFrame);
  await waitFor(d, "hello_ok");
  return d;
}
async function agent(d: Daemon, ref: string, name: string, n: string) {
  d.send(up(`u-${ref}`, ref, name, n));
  await waitFor(d, "agent_ok");
}
/** A round trip: every frame the hub sent before it has arrived. */
async function barrier(d: Daemon, caps: string[]) {
  const id = `b${++seq}`;
  d.send({ ...hello(id), caps } as ClientFrame);
  for (;;) if ((await waitFor(d, "hello_ok")).id === id) return;
}
const acked = (d: Daemon) => framesSeen(d).filter((f) => f.type === "acked");
const stateOf = (msgId: string) =>
  inOwnerHub(
    (s) =>
      s.storage.sql
        .exec("select state from receipts where id = ?", msgId)
        .toArray()[0]?.state,
  );

async function mailTo(cap: string[]) {
  const sm = await machine("S");
  const tm = await machine("T");
  const s = await open(sm.token, []);
  const t = await open(tm.token, cap);
  const n = ns("ackc");
  const rcv = uniq("Rcv");
  await agent(s, "sref", uniq("Snd"), n);
  await agent(t, "rref", rcv, n);
  s.send({
    v: 1,
    id: "send1",
    type: "send",
    from_ref: "sref",
    to_name: rcv,
    body: "hi",
  } as ClientFrame);
  const receipt = (await waitFor(s, "receipt")) as Receipt;
  const dl = await waitFor(t, "deliver");
  expect(dl.msg_id).toBe(receipt.msg_id);
  return { s, t, tm, n, msgId: dl.msg_id };
}

describe("confirmed mail acks (#2198)", () => {
  it("answers only after the receipt is settled", async () => {
    const { t, s, msgId } = await mailTo([BUS_CAPS.ackConfirm]);
    expect(await stateOf(msgId)).toBe("pending");
    expect(acked(t)).toHaveLength(0);
    t.send({ v: 1, id: "a1", type: "ack", msg_id: msgId });
    const a = await waitFor(t, "acked");
    expect(a).toMatchObject({ id: "a1", msg_id: msgId });
    expect(await stateOf(msgId)).toBe("delivered");
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      msg_id: msgId,
      state: "delivered",
    });
  });

  it("a repeat and an unknown id get the same final frame", async () => {
    const { t, msgId } = await mailTo([BUS_CAPS.ackConfirm]);
    t.send({ v: 1, id: "a1", type: "ack", msg_id: msgId });
    await waitFor(t, "acked");
    t.send({ v: 1, id: "a2", type: "ack", msg_id: msgId });
    t.send({ v: 1, id: "a3", type: "ack", msg_id: "nosuchmsgAAAAAAA" });
    await barrier(t, [BUS_CAPS.ackConfirm]);
    expect(acked(t).map((f) => [f.id, f.msg_id])).toEqual([
      ["a1", msgId],
      ["a2", msgId],
      ["a3", "nosuchmsgAAAAAAA"],
    ]);
  });

  it("another machine's ack is answered the same way and settles nothing", async () => {
    const { n, msgId } = await mailTo([BUS_CAPS.ackConfirm]);
    const om = await machine("O");
    const o = await open(om.token, [BUS_CAPS.ackConfirm]);
    await agent(o, "oref", uniq("Oth"), n);
    o.send({ v: 1, id: "x1", type: "ack", msg_id: msgId });
    expect(await waitFor(o, "acked")).toMatchObject({
      id: "x1",
      msg_id: msgId,
    });
    expect(await stateOf(msgId)).toBe("pending");
  });

  it("a socket without the cap hears nothing", async () => {
    const { t, msgId } = await mailTo([]);
    t.send({ v: 1, id: "a1", type: "ack", msg_id: msgId });
    await barrier(t, []);
    expect(acked(t)).toHaveLength(0);
    expect(await stateOf(msgId)).toBe("delivered");
  });

  it("hello_ok lists the cap to a hello that listed it", async () => {
    const m = await machine("C");
    const d = await daemon(m.token);
    d.send({ ...hello("h1"), caps: [BUS_CAPS.ackConfirm] } as ClientFrame);
    expect((await waitFor(d, "hello_ok")).caps).toContain(BUS_CAPS.ackConfirm);
  });
});
