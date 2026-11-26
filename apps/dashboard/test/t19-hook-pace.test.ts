// #1254: T19's side of the runner's hook budget (e2e/staging/hook-pace.ts).
// The ledger itself is tested in test/hook-ledger.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimHookSlot,
  HOOK_LIMIT,
  HookBudgetError,
  hookLedgerDir,
  hookWindowCount,
} from "../e2e/staging/hook-ledger";
import { hookFailure, paceT19Hook } from "../e2e/staging/hook-pace";
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

/** A pinned clock. */
function clock(start = 1_800_000_000_000) {
  let t = start;
  return {
    now: () => t,
    set: (v: number) => {
      t = v;
    },
  };
}

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
    await paceT19Hook(APP, { root, now: c.now });
    expect(hookWindowCount(APP, { root, now: c.now })).toBe(2);
  });

  it("a T19 call past the budget fails at once, named, and waits for nothing", async () => {
    const root = scratch();
    const c = clock();
    for (let i = 0; i < HOOK_LIMIT; i++)
      await claimHookSlot(APP, { root, now: c.now });
    const p = paceT19Hook(APP, { root, now: c.now });
    await expect(p).rejects.toBeInstanceOf(HookBudgetError);
    await expect(p).rejects.toThrow(/^hook budget exhausted: /);
    // The window moves on: the same call then fits.
    c.set(c.now() + 60_001);
    await expect(paceT19Hook(APP, { root, now: c.now })).resolves.toBe(1);
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
      /404 with the hook budget full \(570 of 570.*may be the rate limit, not the key/,
    );
  });
});
