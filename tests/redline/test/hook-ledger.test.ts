// #1254: the runner's hook budget (src/hook-ledger.ts), shared by the live
// suite (src/http.ts paceHook) and T19 (apps/dashboard/e2e/staging).
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hookFailure,
  paceT19Hook,
} from "../../../apps/dashboard/e2e/staging/hook-pace";
import { rlA } from "../../../apps/dashboard/e2e/staging/targets";
import {
  claimHookSlot,
  HOOK_GAP_MS,
  HOOK_LIMIT,
  HOOK_MARGIN,
  HOOK_WINDOW_MS,
  HookBudgetError,
  hook404IsTheKeys,
  hookLedgerDir,
  hookWindowCount,
  RL_ANON_LIMIT,
  RL_ANON_PERIOD_S,
} from "../src/hook-ledger.ts";
import { paceHook } from "../src/http.ts";
import { parseTargets } from "../src/targets.ts";
import { secretDir } from "./fake.ts";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const APP = "https://rl-a.open-artifacts-staging.app";

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "oa-hook-ledger-test-"));
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

/** RL_ANON's `simple` block in a wrangler jsonc (full-line comments stripped). */
function rlAnon(file: string): { limit: number; period: number } {
  const raw = readFileSync(join(ROOT, "apps", "server", file), "utf8")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  const cfg = JSON.parse(raw) as {
    ratelimits: { name: string; simple: { limit: number; period: number } }[];
  };
  const rl = cfg.ratelimits.find((r) => r.name === "RL_ANON");
  if (!rl) throw new Error(`${file}: no RL_ANON`);
  return rl.simple;
}

describe("the budget is RL_ANON's, less a stated margin", () => {
  for (const file of ["wrangler.template.jsonc", "wrangler.test.jsonc"])
    it(`matches ${file}`, () => {
      expect(rlAnon(file)).toEqual({
        limit: RL_ANON_LIMIT,
        period: RL_ANON_PERIOD_S,
      });
    });

  it("is 30 a minute less 5", () => {
    expect(HOOK_MARGIN).toBe(5);
    expect(HOOK_LIMIT).toBe(RL_ANON_LIMIT - HOOK_MARGIN);
    expect(HOOK_WINDOW_MS).toBe(RL_ANON_PERIOD_S * 1000);
  });
});

describe("one ledger per install, the same for the suite and T19", () => {
  it("T19 and the suite derive the same key for the same target", () => {
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
      const env = {
        REDLINE_TARGETS: JSON.stringify({
          mode: "staging",
          a: t("rl-a", "ka"),
          b: t("rl-b", "kb"),
        }),
      };
      const suite = parseTargets(env);
      // T19 reads REDLINE_TARGETS from process.env, as on CI.
      vi.stubEnv("REDLINE_TARGETS", env.REDLINE_TARGETS);
      const t19 = rlA();
      expect(hookLedgerDir(t19.app)).toBe(hookLedgerDir(suite.a.app));
      // Another install never shares it.
      expect(hookLedgerDir(suite.b.app)).not.toBe(hookLedgerDir(suite.a.app));
    } finally {
      vi.unstubAllEnvs();
      s.cleanup();
    }
  });

  it("a suite call and a T19 call count in one window", async () => {
    const root = scratch();
    const c = clock();
    await paceHook({ app: APP } as never, { root, now: c.now });
    await paceT19Hook(APP, { root, now: c.now, sleep: c.sleep });
    expect(hookWindowCount(APP, { root, now: c.now })).toBe(2);
    expect(hookWindowCount("https://rl-b.x.app", { root, now: c.now })).toBe(0);
  });
});

describe("taking a slot is atomic", () => {
  it("two processes can't both take the last slot", async () => {
    const root = scratch();
    const sync = scratch();
    for (let i = 0; i < HOOK_LIMIT - 1; i++) await claimHookSlot(APP, { root });
    const child = (tag: string) =>
      new Promise<string>((res, rej) => {
        const p = spawn(
          process.execPath,
          [
            "--experimental-strip-types",
            "--no-warnings",
            join(import.meta.dirname, "fixtures", "hook-claim-child.ts"),
            root,
            APP,
            tag,
            sync,
          ],
          { stdio: ["ignore", "pipe", "inherit"] },
        );
        let out = "";
        p.stdout.on("data", (d) => {
          out += d;
        });
        p.on("error", rej);
        p.on("exit", (code) =>
          code === 0 ? res(out.trim()) : rej(new Error(`${tag}: exit ${code}`)),
        );
      });
    const runs = [child("x"), child("y")];
    // Both have scanned and found the one free slot before either creates.
    const ready = () =>
      existsSync(join(sync, "x.ready")) && existsSync(join(sync, "y.ready"));
    for (let i = 0; i < 2000 && !ready(); i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(ready()).toBe(true);
    writeFileSync(join(sync, "go"), "");
    const out = (await Promise.all(runs)).sort();
    expect(out).toEqual(["refused", `took ${HOOK_LIMIT}`]);
    expect(hookWindowCount(APP, { root })).toBe(HOOK_LIMIT);
  }, 30_000);
});

describe("nothing is held past a call", () => {
  it("a call that throws after its claim costs one slot; the rest still get budget", async () => {
    const root = scratch();
    const c = clock();
    const call = async (fail: boolean) => {
      await paceHook({ app: APP } as never, {
        root,
        now: c.now,
        sleep: c.sleep,
      });
      if (fail) throw new Error("fetch failed mid-call");
    };
    await expect(call(true)).rejects.toThrow(/mid-call/);
    expect(hookWindowCount(APP, { root, now: c.now })).toBe(1);
    for (let i = 1; i < HOOK_LIMIT; i++) await call(false);
    expect(c.waits).toEqual([]);
    // Only slot files: no lock or temp file is left behind.
    const names = readdirSync(hookLedgerDir(APP, root));
    expect(names).toHaveLength(HOOK_LIMIT);
    for (const n of names) expect(n).toMatch(/^s\d+\.g\d+$/);
  });
});

describe("a claim that throws holds nothing", () => {
  it("a throw inside the claim leaves the whole budget free", async () => {
    const root = scratch();
    const c = clock();
    await expect(
      claimHookSlot(APP, {
        root,
        now: c.now,
        sleep: c.sleep,
        afterScan: async () => {
          throw new Error("died mid-claim");
        },
      }),
    ).rejects.toThrow(/mid-claim/);
    for (let i = 0; i < HOOK_LIMIT; i++)
      await claimHookSlot(APP, { root, now: c.now, sleep: c.sleep });
    expect(c.waits).toEqual([]);
    for (const n of readdirSync(hookLedgerDir(APP, root)))
      expect(n).toMatch(/^s\d+\.g\d+$/);
  });
});

describe("waits come from the ledger, with a deadline", () => {
  it("waits for the oldest call in the window to leave it", async () => {
    const root = scratch();
    const c = clock();
    const t0 = c.now();
    for (let i = 0; i < HOOK_LIMIT; i++) {
      c.set(t0 + i * 1000);
      await claimHookSlot(APP, { root, now: c.now });
    }
    c.set(t0 + 30_000);
    await claimHookSlot(APP, { root, now: c.now, sleep: c.sleep });
    // The oldest (t0) leaves at t0 + 60 s: 30 s from now, plus the edge.
    expect(c.waits).toEqual([HOOK_WINDOW_MS - 30_000 + 100]);
  });

  it("T19 spreads its calls one gap apart", async () => {
    const root = scratch();
    const c = clock();
    await paceT19Hook(APP, { root, now: c.now, sleep: c.sleep });
    c.set(c.now() + 1000);
    await paceT19Hook(APP, { root, now: c.now, sleep: c.sleep });
    expect(c.waits).toEqual([HOOK_GAP_MS - 1000]);
    expect(HOOK_GAP_MS).toBe(Math.ceil(HOOK_WINDOW_MS / HOOK_LIMIT));
  });

  it("past the deadline it fails clearly, without waiting", async () => {
    const root = scratch();
    const c = clock();
    for (let i = 0; i < HOOK_LIMIT; i++)
      await claimHookSlot(APP, { root, now: c.now });
    const p = claimHookSlot(APP, {
      root,
      now: c.now,
      sleep: c.sleep,
      deadline: c.now() + 10_000,
    });
    await expect(p).rejects.toBeInstanceOf(HookBudgetError);
    await expect(p).rejects.toThrow(/^hook budget exhausted: /);
    expect(c.waits).toEqual([]);
  });
});

describe("a hook 404 isn't the key's while the budget is full", () => {
  it("hook404IsTheKeys: only under budget", () => {
    expect(hook404IsTheKeys(HOOK_LIMIT - 1)).toBe(true);
    expect(hook404IsTheKeys(HOOK_LIMIT)).toBe(false);
  });

  it("guard's probe keeps one call free, so its 404 is the key's", async () => {
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

  it("T19 names a 404 with the budget full as maybe the rate limit", async () => {
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
