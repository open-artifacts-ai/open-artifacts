// set_status, from the adapter through the daemon to a stub hub.
import { daemonStatus } from "@oa/bus-ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonDeps } from "../src/index.ts";
import { STATUS_COPY } from "../src/status.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

/** Any version: nothing gates on it. */
const GATE = "0.106.0";

/** The hub's hello_ok, once the daemon has read it (status reports its version). */
async function helloOk(
  h: Awaited<ReturnType<typeof daemonHarness>>,
  server_version = GATE,
) {
  h.toDaemon({
    id: "w",
    type: "hello_ok",
    machine_id: "1".repeat(16),
    machine_label: "laptop",
    server_version,
  });
  await vi.waitFor(async () =>
    expect(
      (await daemonStatus({ path: h.socketPath, timeoutMs: 3000 })).hub_version,
    ).toBe(server_version),
  );
}

/** A daemon, its hub's hello_ok read, with an adapter for agent A. */
async function bus(over: Partial<DaemonDeps> = {}) {
  // The stub hub answers no list: status must not wait for one.
  const h = await daemonHarness({ version: GATE, statusRosterMs: 10, ...over });
  await helloOk(h);
  const a = await h.adapter("A", { client_version: GATE });
  return { h, a };
}
/** Pacing that queues: one token, refilled slowly, and room for two frames. */
const tight = (rate = 4) => ({ pace: { burst: 1, rate, max: 2 } });
/** Startup's frames are out and the bucket holds its one token again. */
const drained = async (h: Awaited<ReturnType<typeof bus>>["h"], ms = 300) => {
  await slow(h, "agent_up");
  await new Promise((r) => setTimeout(r, ms));
};
/** Waits for the n-th frame of a type on a slow queue. */
const slow = async (
  h: Awaited<ReturnType<typeof bus>>["h"],
  type: "list" | "status" | "agent_up",
  n = 1,
) =>
  vi.waitFor(() => expect(h.of(type).length).toBeGreaterThanOrEqual(n), {
    timeout: 4000,
  });
const list = (a: Awaited<ReturnType<typeof bus>>["a"]) =>
  void a.request({ type: "list" }).catch(() => {});

describe("set_status", () => {
  it("answers at once and sends the hub a status frame from the attested agent", async () => {
    const { h, a } = await bus();
    const reply = await a.request({
      type: "set_status",
      state: "working",
      label: "writing tests",
    });
    expect(reply).toEqual({ v: 1, id: expect.any(String), type: "status_set" });
    expect(await h.next("status")).toMatchObject({
      type: "status",
      from_ref: "A",
      state: "working",
      label: "writing tests",
    });
  });

  it.each(["bad_frame", "not_registered"])(
    "a late %s for that id is logged and told on the next call",
    async (code) => {
      const lines: string[] = [];
      const { h, a } = await bus({
        log: (m) => lines.push(m),
        status: { statusEveryMs: 1 },
      });
      await a.request({ type: "set_status", state: "idle" });
      const sent = await h.next("status");
      h.toDaemon({ id: sent.id, type: "error", code, message: "x" });
      await vi.waitFor(() =>
        expect(lines).toContain(`the hub refused a status from A: ${code}`),
      );
      expect(
        await a.request({ type: "set_status", state: "working" }),
      ).toMatchObject({
        type: "status_set",
        earlier: {
          code,
          message: STATUS_COPY[code as keyof typeof STATUS_COPY],
        },
      });
      // Told once.
      expect(
        await a.request({ type: "set_status", state: "working" }),
      ).not.toHaveProperty("earlier");
    },
  );

  it("refuses an invalid status locally: nothing reaches the hub", async () => {
    const { h, a } = await bus();
    for (const bad of [
      { state: "done" },
      { state: "idle", label: "x".repeat(65) },
      { state: "idle", label: "a\u0007b" },
    ])
      expect(await a.request({ type: "set_status", ...bad })).toMatchObject({
        type: "error",
        code: "bad_frame",
      });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.of("status")).toHaveLength(0);
  });

  it("the local guard: one frame per agent per window, the latest kept", async () => {
    const { h, a } = await bus({ status: { statusEveryMs: 300 } });
    const states = ["working", "blocked", "idle", "waiting_on_owner"] as const;
    const replies = states.map((state, i) =>
      a.request({ type: "set_status", state, label: `step ${i}` }),
    );
    // Every call is answered, the superseded ones included.
    for (const r of await Promise.all(replies))
      expect(r).toMatchObject({ type: "status_set" });
    await h.next("status", 2);
    expect(h.of("status").map((f) => [f.state, f.label])).toEqual([
      ["working", "step 0"],
      ["waiting_on_owner", "step 3"],
    ]);
    // Nothing else goes once the window closes with nothing queued.
    await new Promise((r) => setTimeout(r, 400));
    expect(h.of("status")).toHaveLength(2);
    // Each agent has its own window.
    const b = await h.adapter("B", { client_version: GATE });
    await b.request({ type: "set_status", state: "idle" });
    await vi.waitFor(() =>
      expect(h.of("status").at(-1)).toMatchObject({ from_ref: "B" }),
    );
  });

  it("a status the backed-up queue drops goes again, the latest only", async () => {
    const lines: string[] = [];
    const { h, a } = await bus({
      hub: tight(),
      status: { statusEveryMs: 200 },
      log: (m) => lines.push(m),
    });
    await drained(h);
    list(a);
    await slow(h, "list");
    await a.request({ type: "set_status", state: "blocked", label: "dropped" });
    // Two more user frames overflow the queue: the status, oldest, goes.
    list(a);
    list(a);
    await slow(h, "status");
    expect(lines).toContain(
      "hub queue full: dropped a queued status frame (max 2)",
    );
    expect(h.of("status").map((f) => f.label)).toEqual(["dropped"]);
    // Re-sent from the guard, then nothing more.
    await new Promise((r) => setTimeout(r, 600));
    expect(h.of("status")).toHaveLength(1);
  });

  it("a status lost with the link is told on the next call", async () => {
    const { h, a } = await bus({ hub: tight(1) });
    await drained(h, 1100);
    list(a);
    await slow(h, "list");
    await a.request({ type: "set_status", state: "blocked" });
    const first = h.hubSock();
    first?.terminate();
    await vi.waitFor(() => expect(h.hubSock()).not.toBe(first));
    await vi.waitFor(() => expect(h.daemon.hub.open).toBe(true));
    await helloOk(h);
    expect(
      await a.request({ type: "set_status", state: "idle" }),
    ).toMatchObject({
      type: "status_set",
      earlier: { code: "hub_unavailable" },
    });
    expect(h.of("status").every((f) => f.state !== "blocked")).toBe(true);
  });
});

describe("set_status before hello_ok", () => {
  it("open but no hello_ok yet, before or after a drop: hub_unavailable", async () => {
    const h = await daemonHarness({ version: GATE, statusRosterMs: 10 });
    const a = await h.adapter("A", { client_version: GATE });
    const refused = { type: "error", code: "hub_unavailable" };
    expect(
      await a.request({ type: "set_status", state: "idle" }),
    ).toMatchObject(refused);
    await helloOk(h);
    expect(
      await a.request({ type: "set_status", state: "idle" }),
    ).toMatchObject({ type: "status_set" });
    // A reconnect forgets the last hub's version until its hello_ok.
    const first = h.hubSock();
    first?.terminate();
    await vi.waitFor(() => expect(h.hubSock()).not.toBe(first));
    await vi.waitFor(() => expect(h.daemon.hub.open).toBe(true));
    expect(
      await a.request({ type: "set_status", state: "idle" }),
    ).toMatchObject(refused);
  });
});
