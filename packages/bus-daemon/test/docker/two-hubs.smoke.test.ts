// Smoke test for the Docker harness (#2793 S0): two local fake hubs and one
// daemon with a scratch home, connected to hub A only. It runs only inside
// the container (run.sh sets OA_BUS_DOCKER=1); the host vitest run skips it.
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeAll, daemonHarness, stopAll, wsServer } from "../helpers.ts";

describe.skipIf(process.env.OA_BUS_DOCKER !== "1")(
  "docker harness: two hubs, one daemon",
  () => {
    afterEach(async () => {
      await stopAll();
      await closeAll();
    });

    it("starts with a clean container home", () => {
      // The vitest setup swaps HOME for a sentinel, so look at the image's
      // own home: no bus, no harness configs.
      expect(existsSync("/home/tester/.oa-bus")).toBe(false);
      expect(
        readdirSync("/home/tester").filter((n) => n.startsWith(".claude")),
      ).toEqual([]);
    });

    it("connects to hub A and never to hub B", async () => {
      const hubB = await wsServer();
      let bConnections = 0;
      hubB.wss.on("connection", () => {
        bConnections++;
      });
      const scratch = mkdtempSync(join(tmpdir(), "oa-scratch-home-"));
      process.env.OA_BUS_HOME = scratch;
      const a = await daemonHarness();
      await vi.waitFor(() => expect(a.upgrades.length).toBe(1));
      expect(a.daemon.hub.open).toBe(true);
      expect(a.upgrades[0]?.auth).toContain("oa_machine_");
      expect(bConnections).toBe(0);
    });
  },
);
