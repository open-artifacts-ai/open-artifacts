// #1254: T19's side of the runner's hook budget (e2e/staging/hook-pace.ts).
// The ledger itself is tested in tests/redline/test/hook-ledger.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimHookSlot,
  HOOK_GAP_MS,
  HOOK_LIMIT,
  HOOK_WINDOW_MS,
  HookBudgetError,
  hookLedgerDir,
  hookWindowCount,
} from "../../../tests/redline/src/hook-ledger";
import {
  clearT19HookWindow,
  clearTestStart,
  DEADLINE_MARGIN_MS,
  hookDeadline,
  hookFailure,
  markTestStart,
  paceT19Hook,
} from "../e2e/staging/hook-pace";
import { rlA } from "../e2e/staging/targets";

const APP = "https://rl-a.open-artifacts-staging.app";

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "oa-t19-hook-pace-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A pinned clock whose sleep advances it, recording each wait. */
function clock(start = 1_800_000_000_000) {
  let t = start;
  const waits: number[] = [];
  return {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
      // A pacer that never stops waiting fails here, not as a hung run.
      if (t - start > 10 * HOOK_WINDOW_MS)
        throw new Error("runaway: waited over 10 windows of pinned time");
      await new Promise((r) => setImmediate(r));
    },
  };
}

// Playwright's TestInfo, as hook-pace takes it (only `timeout` is read).
type Info = NonNullable<Parameters<typeof hookDeadline>[1]>;
const info = (timeout: number) => ({ timeout }) as unknown as Info;

describe("T19 and the suite share one ledger per install", () => {
  it("T19 keys on rl-a's app origin, exactly as REDLINE_TARGETS gives it", () => {
    // The suite's side (parseTargets, the same a.app): tests/redline's
    // hook-ledger test. Both derive hookLedgerDir(a.app).
    const t = (name: string) => ({
      name,
      installId: `${name}-id`,
      app: `https://${name}.open-artifacts-staging.app`,
      testDomain: `${name}.test`,
      hookKeyFile: "/nonexistent",
    });
    vi.stubEnv(
      "REDLINE_TARGETS",
      JSON.stringify({ mode: "staging", a: t("rl-a"), b: t("rl-b") }),
    );
    expect(rlA().app).toBe(APP);
    expect(hookLedgerDir(rlA().app)).toBe(hookLedgerDir(APP));
  });

  it("a T19 call counts in the app's window, with the suite's claims", async () => {
    const root = scratch();
    const c = clock();
    // claimHookSlot(t.app) is all the suite's paceHook does (src/http.ts).
    await claimHookSlot(APP, { root, now: c.now });
    await paceT19Hook(APP, { root, now: c.now, sleep: c.sleep });
    expect(hookWindowCount(APP, { root, now: c.now })).toBe(2);
  });

  it("T19 spreads its calls one gap apart", async () => {
    const root = scratch();
    const c = clock();
    await paceT19Hook(APP, { root, now: c.now, sleep: c.sleep });
    c.set(c.now() + 1000);
    await paceT19Hook(APP, { root, now: c.now, sleep: c.sleep });
    expect(c.waits).toEqual([HOOK_GAP_MS - 1000]);
  });
});

describe("T19 names a 404 with the budget full as maybe the rate limit", () => {
  it("only when the ledger is full", async () => {
    const root = scratch();
    const c = clock();
    expect(
      hookFailure(APP, "rl-a hook /x", 404, { root, now: c.now }).message,
    ).toBe("rl-a hook /x: 404");
    for (let i = 0; i < HOOK_LIMIT; i++)
      await claimHookSlot(APP, { root, now: c.now });
    expect(
      hookFailure(APP, "rl-a hook /x", 404, { root, now: c.now }).message,
    ).toMatch(
      /404 with the hook budget full \(25 of 25.*may be the rate limit, not the key/,
    );
  });
});

describe("T19's deadline", () => {
  it("counts from the test's start, not its first hook call", () => {
    const i = info(60_000);
    markTestStart(i, 1_000);
    expect(hookDeadline(41_000, i)).toBe(1_000 + 60_000 - DEADLINE_MARGIN_MS);
    // A hook (no test start): from its first call.
    const h = info(60_000);
    expect(hookDeadline(5_000, h)).toBe(5_000 + 60_000 - DEADLINE_MARGIN_MS);
    expect(hookDeadline(9_000, h)).toBe(5_000 + 60_000 - DEADLINE_MARGIN_MS);
    expect(hookDeadline(9_000, info(0))).toBeUndefined();
    expect(hookDeadline(9_000, undefined)).toBeUndefined();
  });

  it("an afterAll call after a long last test isn't refused: the mark is cleared at teardown", async () => {
    const root = scratch();
    const c = clock();
    const i = info(60_000);
    const t0 = c.now();
    // The last test: marked at its start, a hook call just before it ends.
    markTestStart(i, t0);
    c.set(t0 + 57_000);
    await paceT19Hook(APP, { root, now: c.now, sleep: c.sleep, info: i });
    // Its fixtures tear down; afterAll runs with the same TestInfo.
    clearTestStart(i);
    c.set(t0 + 58_000);
    expect(hookDeadline(c.now(), i)).toBe(
      t0 + 58_000 + 60_000 - DEADLINE_MARGIN_MS,
    );
    // Its cleanup call waits out the spread instead of being refused.
    await paceT19Hook(APP, { root, now: c.now, sleep: c.sleep, info: i });
    expect(c.waits).toEqual([HOOK_GAP_MS - 1000]);
  });

  it("paceT19Hook fails with HookBudgetError rather than wait past the test's timeout", async () => {
    const root = scratch();
    const c = clock();
    const i = info(60_000);
    markTestStart(i, c.now());
    for (let k = 0; k < HOOK_LIMIT; k++)
      await claimHookSlot(APP, { root, now: c.now });
    c.set(c.now() + 10_000);
    // The oldest leaves at +60.1 s, past the deadline (+55 s).
    await expect(
      paceT19Hook(APP, { root, now: c.now, sleep: c.sleep, info: i }),
    ).rejects.toBeInstanceOf(HookBudgetError);
    expect(c.waits).toEqual([]);
  });

  it("clearT19HookWindow fails the same way", async () => {
    const root = scratch();
    const c = clock();
    const i = info(20_000);
    markTestStart(i, c.now());
    await claimHookSlot(APP, { root, now: c.now });
    await expect(
      clearT19HookWindow(APP, { root, now: c.now, sleep: c.sleep, info: i }),
    ).rejects.toBeInstanceOf(HookBudgetError);
    expect(c.waits).toEqual([]);
  });
});
