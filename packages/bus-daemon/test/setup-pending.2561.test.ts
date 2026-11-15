// #2561: the bus `self` tool shows "setup pending" to the one session that
// took this machine's mark from the hub. The daemon asks only a hub that
// listed the cap, only for an adapter that listed it, and keeps a mark the
// hub cleared after its asker gave up.

import { ADAPTER_CAPS } from "@oa/bus-ipc";
import { BUS_CAPS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SETUP_PENDING_TEXT } from "../src/routes.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

const helloOk = (caps: string[]) => ({
  id: "w",
  type: "hello_ok" as const,
  machine_id: "1".repeat(16),
  machine_label: "laptop",
  server_version: "1",
  caps,
});
const start = async (caps: string[] = [BUS_CAPS.setup]) => {
  const h = await daemonHarness({ statusRosterMs: 100 });
  h.toDaemon(helloOk(caps));
  // hello_ok is in once the hub-side cap is read: a self then claims.
  await new Promise((r) => setTimeout(r, 50));
  return h;
};
const selfRow = (
  a: Awaited<ReturnType<Awaited<ReturnType<typeof start>>["adapter"]>>,
) =>
  a.request({ type: "self", row: true }) as Promise<{
    agent: { setup_pending?: string };
  }>;
const answerClaims = (
  h: Awaited<ReturnType<typeof start>>,
  pending: boolean,
  delayMs = 0,
) => {
  const seen = new Set<string>();
  const t = setInterval(() => {
    for (const f of h.of("setup_claim"))
      if (!seen.has(f.id)) {
        seen.add(f.id);
        setTimeout(
          () => h.toDaemon({ id: f.id, type: "setup_claimed", pending }),
          delayMs,
        );
      }
  }, 5);
  return () => clearInterval(t);
};

describe("setup pending on self (#2561)", () => {
  it("shows the line when the hub hands over the mark", async () => {
    const h = await start();
    const stop = answerClaims(h, true);
    const a = await h.adapter("A", { caps: [ADAPTER_CAPS.setup] });
    expect((await selfRow(a)).agent.setup_pending).toBe(SETUP_PENDING_TEXT);
    stop();
    expect(h.of("setup_claim")).toHaveLength(1);
  });

  it("shows nothing when the hub says no", async () => {
    const h = await start();
    const stop = answerClaims(h, false);
    const a = await h.adapter("A", { caps: [ADAPTER_CAPS.setup] });
    expect((await selfRow(a)).agent).not.toHaveProperty("setup_pending");
    stop();
  });

  it("an adapter without the cap never takes the mark", async () => {
    const h = await start();
    const stop = answerClaims(h, true);
    const a = await h.adapter("A", { caps: [] });
    expect((await selfRow(a)).agent).not.toHaveProperty("setup_pending");
    stop();
    expect(h.of("setup_claim")).toHaveLength(0);
  });

  it("an older hub (no cap) is never asked", async () => {
    const h = await start([BUS_CAPS.ids]);
    const a = await h.adapter("A", { caps: [ADAPTER_CAPS.setup] });
    expect((await selfRow(a)).agent).not.toHaveProperty("setup_pending");
    expect(h.of("setup_claim")).toHaveLength(0);
  });

  it("self without row (not the tool) never takes it", async () => {
    const h = await start();
    const stop = answerClaims(h, true);
    const a = await h.adapter("A", { caps: [ADAPTER_CAPS.setup] });
    await a.request({ type: "self" });
    stop();
    expect(h.of("setup_claim")).toHaveLength(0);
  });

  it("a mark the hub cleared after the asker gave up goes to the next self", async () => {
    const h = await start();
    // The hub answers after the daemon's 100 ms wait.
    const stop = answerClaims(h, true, 300);
    const a = await h.adapter("A", { caps: [ADAPTER_CAPS.setup] });
    expect((await selfRow(a)).agent).not.toHaveProperty("setup_pending");
    await vi.waitFor(async () =>
      expect((await selfRow(a)).agent.setup_pending).toBe(SETUP_PENDING_TEXT),
    );
    stop();
  });
});
