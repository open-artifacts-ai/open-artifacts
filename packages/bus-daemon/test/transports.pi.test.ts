import type { DaemonFrame } from "@oa/bus-ipc";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/agents.ts";
import { PiTransport } from "../src/transports/pi.ts";

const agent = (over: Partial<AgentRecord> = {}): AgentRecord => ({
  ref: "pi-1",
  kind: "pi",
  proposedName: "p",
  busName: "p",
  namespace: "ns",
  global: false,
  pid: 1,
  cwd: "/",
  live: true,
  ...over,
});
const mail = (msg_id = "mmmmmmmmmmmmmmm1") => ({
  msg_id,
  from_name: "peer",
  namespace: "ns",
  body: "hi",
});

describe("PiTransport", () => {
  it("a push that cannot be written is closed", async () => {
    const t = new PiTransport({ push: () => false, ackTimeoutMs: 50 });
    expect(await t.deliver(agent(), mail())).toEqual({
      ok: false,
      reason: "closed",
    });
  });

  it("pushes the deliver frame on the session's connection", async () => {
    const push = vi.fn((_ref: string, _f: DaemonFrame) => true);
    const t = new PiTransport({ push, ackTimeoutMs: 20 });
    await t.deliver(agent(), mail());
    expect(push).toHaveBeenCalledWith(
      "pi-1",
      expect.objectContaining({
        type: "deliver",
        msg_id: "mmmmmmmmmmmmmmm1",
        from_name: "peer",
        namespace: "ns",
        body: "hi",
      }),
    );
  });

  it("an oversized message is pushed as a notice, not a body", async () => {
    const push = vi.fn((_ref: string, _f: DaemonFrame) => true);
    const t = new PiTransport({ push, ackTimeoutMs: 20 });
    await t.deliver(agent(), {
      ...mail(),
      notice: { size: 9, msg_id: "mmmmmmmmmmmmmmm1" },
    });
    const f = push.mock.calls[0][1] as Extract<
      DaemonFrame,
      { type: "deliver" }
    >;
    expect(f.notice).toEqual({ size: 9, msg_id: "mmmmmmmmmmmmmmm1" });
    expect(f.body).toBeUndefined();
  });

  it("no ack within the timeout is a timeout", async () => {
    const t = new PiTransport({ push: () => true, ackTimeoutMs: 30 });
    expect(await t.deliver(agent(), mail())).toEqual({
      ok: false,
      reason: "timeout",
    });
  });

  it("an ack resolves ok exactly once", async () => {
    const t = new PiTransport({ push: () => true, ackTimeoutMs: 1000 });
    const done = t.deliver(agent(), mail());
    expect(t.acked("mmmmmmmmmmmmmmm1", "pi-1")).toBe(true);
    expect(t.acked("mmmmmmmmmmmmmmm1", "pi-1")).toBe(false);
    expect(await done).toEqual({ ok: true });
  });

  it("an ack from another agent cannot confirm", async () => {
    const t = new PiTransport({ push: () => true, ackTimeoutMs: 40 });
    const done = t.deliver(agent(), mail());
    expect(t.acked("mmmmmmmmmmmmmmm1", "pi-2")).toBe(false);
    expect(await done).toEqual({ ok: false, reason: "timeout" });
  });

  it("a notice is pushed as a notice frame; false when it cannot be written", async () => {
    const push = vi.fn((_ref: string, _f: DaemonFrame) => true);
    const t = new PiTransport({ push });
    expect(await t.notify(agent(), "×  Expired: x", "mmmmmmmmmmmmmmm1")).toBe(
      true,
    );
    expect(push).toHaveBeenCalledWith(
      "pi-1",
      expect.objectContaining({
        type: "notice",
        text: "×  Expired: x",
        msg_id: "mmmmmmmmmmmmmmm1",
      }),
    );
    const shut = new PiTransport({ push: () => false });
    expect(await shut.notify(agent(), "x", "mmmmmmmmmmmmmmm1")).toBe(false);
  });

  it("a late ack from the same session is remembered for a while; from another, never", async () => {
    const t = new PiTransport({
      push: () => true,
      ackTimeoutMs: 20,
      lateAckMs: 200,
    });
    expect(await t.deliver(agent(), mail())).toEqual({
      ok: false,
      reason: "timeout",
    });
    expect(t.acked("mmmmmmmmmmmmmmm1", "pi-2")).toBe(false);
    expect(t.lateAck("mmmmmmmmmmmmmmm1", "pi-2")).toBe(false);
    expect(t.lateAck("mmmmmmmmmmmmmmm1", "pi-1")).toBe(true);
    // Used once.
    expect(t.lateAck("mmmmmmmmmmmmmmm1", "pi-1")).toBe(false);
  });

  it("a late ack window closes", async () => {
    const t = new PiTransport({
      push: () => true,
      ackTimeoutMs: 10,
      lateAckMs: 30,
    });
    await t.deliver(agent(), mail());
    await new Promise((r) => setTimeout(r, 60));
    expect(t.lateAck("mmmmmmmmmmmmmmm1", "pi-1")).toBe(false);
  });

  it("dropRef closes that session's waiting deliveries at once, and only its", async () => {
    const t = new PiTransport({ push: () => true, ackTimeoutMs: 5_000 });
    const mine = t.deliver(agent(), mail());
    const other = t.deliver(agent({ ref: "pi-2" }), mail("mmmmmmmmmmmmmmm2"));
    t.dropRef("pi-1");
    expect(await mine).toEqual({ ok: false, reason: "closed" });
    expect(t.acked("mmmmmmmmmmmmmmm2", "pi-2")).toBe(true);
    expect(await other).toEqual({ ok: true });
  });
});
