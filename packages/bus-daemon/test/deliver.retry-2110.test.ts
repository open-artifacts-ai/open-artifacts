// #2110: a timeout where nothing was written to the session is retried locally
// (2 s, 5 s, 15 s). After the last one nothing is refused (a refuse is final at
// the hub): the record closes as a liveness miss and the sync reopens it.
import type { DeliverFrame } from "@oa/bus-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTable } from "../src/agents.ts";
import { createDeliver, type DeliverOutcome } from "../src/deliver.ts";

const frame = (msg_id = "mmmmmmmmmmmmmmm1"): DeliverFrame => ({
  v: 1,
  id: `d-${msg_id}`,
  type: "deliver",
  msg_id,
  to_ref: "A",
  from_name: "peer",
  namespace: "ns",
  body: "hi",
});
const RETRYABLE: DeliverOutcome = {
  ok: false,
  reason: "timeout",
  retryable: true,
};

function setup(outcomes: (n: number) => DeliverOutcome) {
  const agents = new AgentTable();
  const agent = agents.up({
    ref: "A",
    kind: "pi",
    proposedName: "a",
    busName: "a",
    namespace: "ns",
    global: false,
    pid: 1,
    cwd: "/",
    live: true,
  });
  const sent: { type: string }[] = [];
  const closed: (string | undefined)[] = [];
  let calls = 0;
  const d = createDeliver({
    agents,
    hub: {
      send: (f) => {
        sent.push(f as { type: string });
        return true;
      },
    },
    transports: { pi: async () => outcomes(++calls) },
    onClosed: (_a, by) => {
      closed.push(by);
      return by;
    },
  });
  return { d, agent, sent, closed, calls: () => calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("local retry of a retryable timeout (#2110)", () => {
  it("an unknown target is retried at 2 s and delivered", async () => {
    const t = setup((n) => (n === 1 ? RETRYABLE : { ok: true }));
    await t.d.deliver(frame());
    expect(t.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(t.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.calls()).toBe(2);
    expect(t.sent.map((f) => f.type)).toEqual(["ack"]);
  });

  it("four retryable timeouts close the record as a liveness miss, with no refuse", async () => {
    const t = setup(() => RETRYABLE);
    await t.d.deliver(frame());
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.agent.live).toBe(true);
    await vi.advanceTimersByTimeAsync(15000);
    expect(t.calls()).toBe(4);
    expect(t.agent.live).toBe(false);
    expect(t.closed).toEqual(["liveness"]);
    expect(t.sent).toEqual([]);
  });

  it("a timeout after connecting is not retried", async () => {
    const t = setup(() => ({ ok: false, reason: "timeout" }));
    await t.d.deliver(frame());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.calls()).toBe(1);
    expect(t.agent.live).toBe(true);
    expect(t.sent).toEqual([]);
  });

  it("stop() clears pending retries", async () => {
    const t = setup(() => RETRYABLE);
    await t.d.deliver(frame());
    t.d.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.calls()).toBe(1);
  });

  it("a redelivery of the same id joins the chain instead of starting a second", async () => {
    const t = setup(() => RETRYABLE);
    await t.d.deliver(frame());
    await t.d.deliver(frame()); // the hub's redelivery: its own attempt only
    expect(t.calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.calls()).toBe(3); // one chain: one retry, not two
  });

  it("a record that closed meanwhile stops the chain without a refuse", async () => {
    const t = setup(() => RETRYABLE);
    await t.d.deliver(frame());
    t.agent.live = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.calls()).toBe(1);
    expect(t.sent).toEqual([]);
  });

  it("stop() while an attempt is in flight leaves no chain behind", async () => {
    let finish!: (o: DeliverOutcome) => void;
    const agents = new AgentTable();
    agents.up({
      ref: "A",
      kind: "pi",
      proposedName: "a",
      busName: "a",
      namespace: "ns",
      global: false,
      pid: 1,
      cwd: "/",
      live: true,
    });
    let calls = 0;
    const d = createDeliver({
      agents,
      hub: { send: () => true },
      transports: {
        pi: () =>
          new Promise<DeliverOutcome>((r) => {
            calls++;
            finish = r;
          }),
      },
      onClosed: () => {},
    });
    const p = d.deliver(frame());
    d.stop();
    finish(RETRYABLE);
    await p;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);
  });

  it("after 3 chain-exhaustion closes in 10 minutes the record stays closed as a delivery close", async () => {
    const t = setup(() => RETRYABLE);
    for (let i = 1; i <= 4; i++) {
      t.agent.live = true;
      await t.d.deliver(frame(`mmmmmmmmmmmmmmm${i}`));
      await vi.advanceTimersByTimeAsync(22_000);
    }
    expect(t.closed).toEqual(["liveness", "liveness", "liveness", "delivery"]);
  });

  it("the exhaustion budget expires after 10 minutes", async () => {
    const t = setup(() => RETRYABLE);
    for (let i = 1; i <= 3; i++) {
      t.agent.live = true;
      await t.d.deliver(frame(`mmmmmmmmmmmmmmm${i}`));
      await vi.advanceTimersByTimeAsync(22_000);
    }
    await vi.advanceTimersByTimeAsync(600_000);
    t.agent.live = true;
    await t.d.deliver(frame("mmmmmmmmmmmmmmm4"));
    await vi.advanceTimersByTimeAsync(22_000);
    expect(t.closed).toEqual(["liveness", "liveness", "liveness", "liveness"]);
  });
});
