import { AGENT_CAP_MESSAGES } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MACHINE_CAP_COPY, MEMBER_CAP_COPY } from "../src/routes.ts";
import { daemonHarness, eventCounter, stopAll } from "./helpers.ts";

afterEach(async () => {
  await stopAll();
  vi.useRealTimers();
});

/** A harness whose log says when the daemon has marked an agent rate-limited. */
async function limitHarness(over: Parameters<typeof daemonHarness>[0] = {}) {
  const logs: string[] = [];
  const waiters: (() => void)[] = [];
  const h = await daemonHarness({
    log: (m) => {
      logs.push(m);
      for (const w of waiters.splice(0)) w();
    },
    ...over,
  });
  /** The hub's refusal is on another socket: a request sent before it lands goes to the hub. */
  const marked = async (ref: string) => {
    const line = `the hub refused to register ${ref}: too many agents (rate limited)`;
    while (!logs.includes(line))
      await new Promise<void>((r) => waiters.push(r));
  };
  return { ...h, marked };
}

const limited = (id: string, message = "too many agents") => ({
  id,
  type: "error",
  code: "rate_limited",
  message,
});

describe("agent cap copy", () => {
  it("states the contract's copy verbatim", () => {
    expect(MACHINE_CAP_COPY).toBe(
      "This machine has too many agents on the bus right now. Close a session you no longer need; this one retries in a few minutes.",
    );
    expect(MEMBER_CAP_COPY).toBe(
      "Your bus has too many agents right now. Close a session you no longer need; this one retries in a few minutes.",
    );
  });

  it.each([
    ["machine", AGENT_CAP_MESSAGES.machine, MACHINE_CAP_COPY],
    ["member", AGENT_CAP_MESSAGES.member, MEMBER_CAP_COPY],
    ["unknown", "something else", MACHINE_CAP_COPY],
  ])("%s message gets its copy", async (_n, message, copy) => {
    const h = await limitHarness();
    const a = await h.adapter("A");
    const up = await h.next("agent_up");
    h.toDaemon(limited(up.id, message));
    await h.marked("A");
    expect(await a.request({ type: "list" })).toMatchObject({
      code: "rate_limited",
      message: copy,
    });
  });
});

describe("a rate-limited agent_up", () => {
  it("answers the agent's requests with the copy, never forwarding them", async () => {
    const h = await limitHarness();
    const a = await h.adapter("A");
    const up = await h.next("agent_up");
    h.toDaemon(limited(up.id));
    await h.marked("A");
    expect(await a.request({ type: "list" })).toMatchObject({
      type: "error",
      code: "rate_limited",
      message: expect.stringMatching(/too many agents on the bus/),
    });
    expect(
      await a.request({ type: "send", to: "b", body: "hi" }),
    ).toMatchObject({ type: "error", code: "rate_limited" });
    expect(h.of("list")).toEqual([]);
    expect(h.of("send")).toEqual([]);
  });

  it("is not retried in a loop", async () => {
    const syncs = eventCounter();
    // The sync interval and the retry timer: both on a clock moved by hand.
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    const h = await limitHarness({
      claude: { syncMs: 20, onSync: () => syncs.hook() },
      limitedRetryMs: 60_000,
    });
    await h.adapter("A");
    const up = await h.next("agent_up");
    h.toDaemon(limited(up.id));
    await h.marked("A"); // the daemon took the limit; the retry timer is armed
    // Several syncs after the limit: each would have announced A again.
    const before = syncs.count;
    await vi.advanceTimersByTimeAsync(300); // the original 300 ms window
    expect(syncs.count - before).toBeGreaterThanOrEqual(14); // the window really ran
    await h.quiet();
    expect(h.of("agent_up")).toHaveLength(1);
  });

  it("is retried after the long backoff, and an agent_ok clears it", async () => {
    const h = await daemonHarness({ limitedRetryMs: 200 });
    const a = await h.adapter("A");
    const up = await h.next("agent_up");
    h.toDaemon(limited(up.id));
    const again = await h.next("agent_up", 2);
    expect(again.agent_ref).toBe("A");
    h.toDaemon({
      id: again.id,
      type: "agent_ok",
      agent_ref: "A",
      bus_name: "a",
    });
    await vi.waitFor(() => {
      a.request({ type: "list" }).catch(() => {});
      expect(h.of("list").length).toBeGreaterThan(0);
    });
  });

  it("is retried on the next reconnect", async () => {
    const h = await limitHarness({ limitedRetryMs: 60_000 });
    await h.adapter("A");
    const up = await h.next("agent_up");
    h.toDaemon(limited(up.id));
    await h.marked("A");
    h.hubSock()?.close();
    await h.next("agent_up", 2);
  });

  it("leaves other agents and other errors alone", async () => {
    const h = await limitHarness();
    const a = await h.adapter("A");
    const b = await h.adapter("B");
    const upA = await h.next("agent_up");
    await h.next("agent_up", 2);
    h.toDaemon(limited(upA.id));
    // An error for a request id is not a registration refusal.
    h.toDaemon(limited("not-an-agent-up"));
    b.request({ type: "list" }).catch(() => {});
    await vi.waitFor(() => expect(h.of("list")).toHaveLength(1));
    await h.marked("A");
    expect(await a.request({ type: "list" })).toMatchObject({
      code: "rate_limited",
    });
  });
});

describe("fair, at-most-once user requests", () => {
  it("a request that times out while still queued never goes out", async () => {
    // The pending timer and the pacer's refill run on a clock moved by hand.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const h = await daemonHarness({
        hub: { backoffMs: () => 20, pace: { rate: 2, burst: 1 } },
        pendingTimeoutMs: 200,
      });
      const a = await h.adapter("A");
      const reply = a.request({ type: "list" });
      await a.request({ type: "self" }); // answered after the list was read and queued
      await vi.advanceTimersByTimeAsync(200);
      expect(await reply).toMatchObject({
        type: "error",
        code: "timeout",
      });
      await vi.advanceTimersByTimeAsync(5_000); // far past every refill
      await h.quiet();
      expect(h.of("agent_up")).toHaveLength(1);
      expect(h.of("list")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a rate limit mark goes when its agent goes down", async () => {
    const h = await limitHarness({ limitedRetryMs: 60_000 });
    const a = await h.adapter("P", { kind: "pi" });
    const up = await h.next("agent_up");
    h.toDaemon(limited(up.id));
    await h.marked("P");
    expect(await a.request({ type: "list" })).toMatchObject({
      code: "rate_limited",
    });
    a.close();
    await h.next("sessions", 2);
    const b = await h.adapter("P", { kind: "pi" });
    await h.next("agent_up", 2);
    b.request({ type: "list" }).catch(() => {});
    await vi.waitFor(() => expect(h.of("list")).toHaveLength(1));
  });
});
