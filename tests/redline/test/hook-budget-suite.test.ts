// #1254: the suite's side of the runner's hook budget. The ledger and its
// own tests are public (apps/dashboard/e2e/staging/hook-ledger.ts,
// apps/dashboard/test/hook-ledger.test.ts); the suite imports it, never the
// other way round.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimHookSlot,
  HOOK_LIMIT,
  hook404IsTheKeys,
  hookLedgerDir,
  hookWindowCount,
} from "../../../apps/dashboard/e2e/staging/hook-ledger.ts";
import { paceHook } from "../src/http.ts";
import { parseTargets } from "../src/targets.ts";
import { secretDir } from "./fake.ts";

const APP = "https://rl-a.open-artifacts-staging.app";

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "oa-hook-budget-suite-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A pinned clock whose sleep advances it, recording each wait. */
function clock(start = 1_800_000_000_000) {
  let t = start;
  const waits: number[] = [];
  return {
    now: () => t,
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
      await new Promise((r) => setImmediate(r));
    },
  };
}

describe("one ledger per install, the same for the suite and T19", () => {
  // T19 keys on rl-a's app origin from REDLINE_TARGETS too (rlA().app; its
  // side: apps/dashboard/test/t19-hook-pace.test.ts). Both use the JSON's
  // a.app as given, so both derive hookLedgerDir(a.app).
  it("the suite keys on the target's app origin, exactly as REDLINE_TARGETS gives it", () => {
    const s = secretDir({ ka: "a".repeat(40), kb: "b".repeat(40) });
    try {
      const t = (name: string, f: string) => ({
        name,
        installId: `${name}-id`,
        app: `https://${name}.open-artifacts-staging.app`,
        content: `https://${name}.open-artifacts-staging.page`,
        testDomain: `${name}.test`,
        hookKeyFile: s.path(f),
      });
      const suite = parseTargets({
        REDLINE_TARGETS: JSON.stringify({
          mode: "staging",
          a: t("rl-a", "ka"),
          b: t("rl-b", "kb"),
        }),
      });
      expect(suite.a.app).toBe(APP);
      expect(hookLedgerDir(suite.a.app)).toBe(hookLedgerDir(APP));
      // Another install never shares it.
      expect(hookLedgerDir(suite.b.app)).not.toBe(hookLedgerDir(suite.a.app));
    } finally {
      s.cleanup();
    }
  });

  it("a suite call counts in the app's window, where T19's claims count too", async () => {
    const root = scratch();
    const c = clock();
    await paceHook({ app: APP } as never, { root, now: c.now });
    await claimHookSlot(APP, { root, now: c.now });
    expect(hookWindowCount(APP, { root, now: c.now })).toBe(2);
    expect(hookWindowCount("https://rl-b.x.app", { root, now: c.now })).toBe(0);
  });
});

describe("guard's wrong-key probe", () => {
  it("paces with one call kept free, so its 404 is the key's", async () => {
    const root = scratch();
    const c = clock();
    for (let i = 0; i < HOOK_LIMIT - 1; i++)
      await claimHookSlot(APP, { root, now: c.now });
    const n = await paceHook({ app: APP } as never, {
      root,
      now: c.now,
      sleep: c.sleep,
      reserve: 1,
    });
    // It waited for room rather than take the last slot.
    expect(c.waits).toHaveLength(1);
    expect(hook404IsTheKeys(n)).toBe(true);
  });
});
