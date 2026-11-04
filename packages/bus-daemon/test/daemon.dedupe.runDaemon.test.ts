import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeliverOutcome } from "../src/deliver.ts";
import { daemonHarness, deliverFrame, stopAll } from "./helpers.ts";

afterEach(stopAll);

const settle = () => new Promise((r) => setTimeout(r, 50));

async function piHarness(
  transport: (...a: unknown[]) => Promise<DeliverOutcome>,
) {
  const h = await daemonHarness({ transports: { pi: transport } });
  await h.adapter("A", { kind: "pi" });
  return h;
}

describe("daemon.dedupe through runDaemon's deliver handler", () => {
  it("injects a repeated msg_id once and acks it each time", async () => {
    const transport = vi.fn(
      async (..._a: unknown[]) => ({ ok: true }) as const,
    );
    const h = await piHarness(transport);
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1"));
    await h.next("ack", 1);
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1"));
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1"));
    await h.next("ack", 3);
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      msg_id: "mmmmmmmmmmmmmmm1",
      from_name: "peer",
      body: "hi",
    });
    expect(h.of("ack").map((a) => a.msg_id)).toEqual([
      "mmmmmmmmmmmmmmm1",
      "mmmmmmmmmmmmmmm1",
      "mmmmmmmmmmmmmmm1",
    ]);
  });

  it("joins a redelivery that lands while the first transport call is pending", async () => {
    let finish!: (o: DeliverOutcome) => void;
    const transport = vi.fn(
      () =>
        new Promise<DeliverOutcome>((r) => {
          finish = r;
        }),
    );
    const h = await piHarness(transport);
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1"));
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1"));
    await settle();
    expect(transport).toHaveBeenCalledOnce();
    expect(h.of("ack")).toEqual([]);
    finish({ ok: true });
    await h.next("ack", 2);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("leaves a timed-out delivery retryable and never acks it", async () => {
    const transport = vi
      .fn<(...a: unknown[]) => Promise<DeliverOutcome>>()
      .mockResolvedValueOnce({ ok: false, reason: "timeout" })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ok: true });
    const h = await piHarness(transport);
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1"));
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    await settle();
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1"));
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    await settle();
    expect(h.of("ack")).toEqual([]);
    expect(h.of("refuse")).toEqual([]);
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1"));
    expect(await h.next("ack")).toMatchObject({ msg_id: "mmmmmmmmmmmmmmm1" });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("refuses with the transport's cause and never acks", async () => {
    const transport = vi.fn(
      async () => ({ ok: false, reason: "closed", cause: "denied" }) as const,
    );
    const h = await piHarness(transport);
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1"));
    expect(await h.next("refuse")).toMatchObject({
      msg_id: "mmmmmmmmmmmmmmm1",
      reason: "closed",
      detail: "denied",
    });
    expect(h.of("ack")).toEqual([]);
  });

  it("reports a session the transport found closed, injecting nothing more", async () => {
    const transport = vi.fn(
      async () => ({ ok: false, reason: "closed" }) as const,
    );
    const h = await piHarness(transport);
    const n = h.of("sessions").length;
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1"));
    expect(await h.next("refuse")).toMatchObject({
      msg_id: "mmmmmmmmmmmmmmm1",
      detail: "dropped",
    });
    expect(await h.next("sessions", n + 1)).toMatchObject({
      open: [],
      closed: ["A"],
    });
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm2"));
    await h.next("refuse", 2);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("sends a fetch notice for an oversized message", async () => {
    const transport = vi.fn(
      async (..._a: unknown[]) => ({ ok: true }) as const,
    );
    const h = await piHarness(transport);
    const { body: _, ...frame } = deliverFrame("mmmmmmmmmmmmmmm1");
    h.toDaemon({
      ...frame,
      notice: { size: 40_000, msg_id: "mmmmmmmmmmmmmmm1" },
    });
    await h.next("ack");
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      body: expect.stringContaining("msg_id mmmmmmmmmmmmmmm1"),
    });
  });
});
