// O1: self-host runs RECOVERY_CRON every 2 min on Workers Free (10 ms of CPU
// per invocation). An idle tick off the daily slot is the windowed lost index
// and thumbnail sweep: two indexed D1 reads (cron.recovery.test.ts counts
// them). Its wall time in local workerd, D1 I/O included, stays well under
// 10 ms: reported, asserted under test:cpu:strict (budget(),
// docs/ops/cpu-budget.md). Runs serially via vitest.cpu.config.ts.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { inDailySlot, RECOVERY_CRON, scheduled } from "../src/cron.js";
import type { Env } from "../src/env.js";
import { budget, medianMs } from "./cpu-time.js";

/** 2026-01-06 12:00 UTC: off the daily slot, past every row in the suite. */
const NOON = Date.UTC(2026, 0, 6, 12, 0);

describe("RECOVERY_CRON idle tick CPU", () => {
  it("an idle tick with server thumbnails on stays well under 10 ms wall", async ({
    annotate,
  }) => {
    expect(inDailySlot(NOON)).toBe(false);
    const e = {
      ...(env as Env),
      BROWSER: {} as Fetcher,
      SERVER_THUMBNAILS: "on",
    } as Env;
    const idle = async () => {
      const pending: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (p: Promise<unknown>) => void pending.push(p),
        passThroughOnException() {},
        props: {},
      } as unknown as ExecutionContext;
      await scheduled({ cron: RECOVERY_CRON, scheduledTime: NOON }, e, ctx);
      await Promise.all(pending);
      // The sweep only: no daily work registered.
      expect(pending).toHaveLength(1);
    };
    const ms = await medianMs(idle);
    await budget(annotate, "idle RECOVERY_CRON tick", ms, 5);
  });
});
