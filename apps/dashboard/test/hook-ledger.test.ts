// #1254: the runner's hook budget (e2e/staging/hook-ledger.ts), shared by
// T19 and the red-line live suite. T19's side: t19-hook-pace.test.ts; the
// suite's side: tests/redline/test/hook-budget-suite.test.ts.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimHookSlot,
  HOOK_LIMIT,
  HOOK_MARGIN,
  HOOK_WINDOW_MS,
  HookBudgetError,
  hook404IsTheKeys,
  hookLedgerDir,
  hookWindowCount,
  RL_HOOKS_LIMIT,
  RL_HOOKS_PERIOD_S,
  STALE_TMP_MS,
} from "../e2e/staging/hook-ledger";

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

/** RL_HOOKS's `simple` block in a wrangler jsonc (full-line comments stripped). */
function rlHooks(file: string): { limit: number; period: number } {
  const raw = readFileSync(join(ROOT, "apps", "server", file), "utf8")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  const parsed = JSON.parse(raw) as {
    ratelimits?: { name: string; simple: { limit: number; period: number } }[];
    env?: Record<string, { ratelimits: NonNullable<typeof parsed.ratelimits> }>;
  };
  // The staging config nests its bindings under env.staging.
  const cfg = parsed.ratelimits ? parsed : Object.values(parsed.env ?? {})[0];
  const rl = cfg?.ratelimits?.find((r) => r.name === "RL_HOOKS");
  if (!rl) throw new Error(`${file}: no RL_HOOKS`);
  return rl.simple;
}

describe("the budget is RL_HOOKS's, less a stated margin", () => {
  // Not the install template: no release code reads RL_HOOKS.
  for (const file of ["wrangler.staging.jsonc", "wrangler.test.jsonc"])
    it(`matches ${file}`, () => {
      expect(rlHooks(file)).toEqual({
        limit: RL_HOOKS_LIMIT,
        period: RL_HOOKS_PERIOD_S,
      });
    });

  it("is 600 a minute less 30", () => {
    expect(HOOK_MARGIN).toBe(30);
    expect(HOOK_LIMIT).toBe(RL_HOOKS_LIMIT - HOOK_MARGIN);
    expect(HOOK_WINDOW_MS).toBe(RL_HOOKS_PERIOD_S * 1000);
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
            join(import.meta.dirname, "fixtures", "hook-claim-child.mjs"),
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
      await claimHookSlot(APP, {
        root,
        now: c.now,
      });
      if (fail) throw new Error("fetch failed mid-call");
    };
    await expect(call(true)).rejects.toThrow(/mid-call/);
    expect(hookWindowCount(APP, { root, now: c.now })).toBe(1);
    for (let i = 1; i < HOOK_LIMIT; i++) await call(false);
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
        afterScan: async () => {
          throw new Error("died mid-claim");
        },
      }),
    ).rejects.toThrow(/mid-claim/);
    for (let i = 0; i < HOOK_LIMIT; i++)
      await claimHookSlot(APP, { root, now: c.now });
    for (const n of readdirSync(hookLedgerDir(APP, root)))
      expect(n).toMatch(/^s\d+\.g\d+$/);
  });
});

describe("a call past the budget fails at once", () => {
  it("names the wait for the oldest call to leave the window, and never waits", async () => {
    const root = scratch();
    const c = clock();
    const t0 = c.now();
    for (let i = 0; i < HOOK_LIMIT; i++) {
      c.set(t0 + i * 10);
      await claimHookSlot(APP, { root, now: c.now });
    }
    c.set(t0 + 30_000);
    const p = claimHookSlot(APP, { root, now: c.now });
    await expect(p).rejects.toBeInstanceOf(HookBudgetError);
    await expect(p).rejects.toThrow(/^hook budget exhausted: /);
    await expect(p).rejects.toThrow(/the next fits in 30 s/);
    // The oldest leaves at t0 + 60 s: then the call fits.
    c.set(t0 + HOOK_WINDOW_MS + 1);
    await expect(claimHookSlot(APP, { root, now: c.now })).resolves.toBe(
      HOOK_LIMIT,
    );
  });
});

describe("a hook 404 isn't the key's while the budget is full", () => {
  it("hook404IsTheKeys: only under budget", () => {
    expect(hook404IsTheKeys(HOOK_LIMIT - 1)).toBe(true);
    expect(hook404IsTheKeys(HOOK_LIMIT)).toBe(false);
  });

  it("a claim with reserve 1 keeps one call free (guard's probe)", async () => {
    const root = scratch();
    const c = clock();
    for (let i = 0; i < HOOK_LIMIT - 1; i++)
      await claimHookSlot(APP, { root, now: c.now });
    // One call is left, and reserve 1 refuses to take it.
    await expect(
      claimHookSlot(APP, { root, now: c.now, reserve: 1 }),
    ).rejects.toBeInstanceOf(HookBudgetError);
    expect(hook404IsTheKeys(hookWindowCount(APP, { root, now: c.now }))).toBe(
      true,
    );
  });
});

/** Writes a raw slot file (as an older writer or a crash would leave it). */
function rawSlot(root: string, name: string, body: string, mtimeMs: number) {
  const dir = hookLedgerDir(APP, root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, name);
  writeFileSync(p, body, { mode: 0o600 });
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
}

describe("slot times that aren't a plain past time", () => {
  it("an empty slot file older than the window has left it", async () => {
    const root = scratch();
    const c = clock();
    rawSlot(root, "s0.g0", "", c.now() - 2 * HOOK_WINDOW_MS);
    expect(hookWindowCount(APP, { root, now: c.now })).toBe(0);
  });

  it("an empty slot file made inside the window counts until its mtime leaves it", async () => {
    const root = scratch();
    const c = clock();
    const t0 = c.now();
    rawSlot(root, "s0.g0", "", t0 - 20_000);
    expect(hookWindowCount(APP, { root, now: c.now })).toBe(1);
    c.set(t0 - 20_000 + HOOK_WINDOW_MS + 1);
    expect(hookWindowCount(APP, { root, now: c.now })).toBe(0);
  });

  it("a time from the future falls back to the file's mtime, never later than now", async () => {
    const root = scratch();
    const c = clock();
    const t0 = c.now();
    rawSlot(root, "s0.g0", String(t0 + 3_600_000), t0 - 30_000);
    expect(hookWindowCount(APP, { root, now: c.now })).toBe(1);
    c.set(t0 - 30_000 + HOOK_WINDOW_MS + 1);
    expect(hookWindowCount(APP, { root, now: c.now })).toBe(0);
  });

  it("a future mtime is capped at now", async () => {
    const root = scratch();
    const c = clock();
    const t0 = c.now();
    // Corrupt content, so the mtime is used; the mtime is an hour ahead.
    rawSlot(root, "s0.g0", "x", t0 + 3_600_000);
    expect(hookWindowCount(APP, { root, now: c.now })).toBe(1);
    // With room for one call, the next fits one window from now, not an hour
    // ahead (the claim's message names the wait).
    await expect(
      claimHookSlot(APP, { root, now: c.now, reserve: HOOK_LIMIT - 1 }),
    ).rejects.toThrow(/the next fits in 60 s/);
  });

  it("temp files a crash left are swept on first use; a fresh one stays", async () => {
    const root = scratch();
    const dir = hookLedgerDir(APP, root);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const old = join(dir, "tmp.1.aaaaaaaaaaaa");
    const recent = join(dir, "tmp.2.bbbbbbbbbbbb");
    writeFileSync(old, "1", { mode: 0o600 });
    writeFileSync(recent, "1", { mode: 0o600 });
    const t = (Date.now() - STALE_TMP_MS - 60_000) / 1000;
    utimesSync(old, t, t);
    hookWindowCount(APP, { root });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it("a slot file is linked in complete: no temp file is left", async () => {
    const root = scratch();
    await claimHookSlot(APP, { root });
    const names = readdirSync(hookLedgerDir(APP, root));
    expect(names).toEqual(["s0.g0"]);
    expect(
      Number(readFileSync(join(hookLedgerDir(APP, root), "s0.g0"), "utf8")),
    ).toBeGreaterThan(0);
  });
});

describe("the generation chain", () => {
  it("keeps the generation before the newest, so a stale scanner collides", async () => {
    const root = scratch();
    const c = clock();
    for (let i = 0; i < 3; i++) {
      await claimHookSlot(APP, { root, now: c.now });
      c.set(c.now() + HOOK_WINDOW_MS + 1);
    }
    const names = readdirSync(hookLedgerDir(APP, root)).sort();
    expect(names).toEqual(["s0.g1", "s0.g2"]);
  });

  it("a stale claim that takes a generation older than the newest is undone", async () => {
    const root = scratch();
    const c = clock();
    // Slot 0's g0 is stale, so a claim scans and picks s0.g1.
    rawSlot(root, "s0.g0", String(c.now() - 2 * HOOK_WINDOW_MS), c.now());
    let stalled = false;
    const n = await claimHookSlot(APP, {
      root,
      now: c.now,
      afterScan: async () => {
        if (stalled) return;
        stalled = true;
        // While it stalled: others took g1 and g2 and unlinked g1's
        // predecessor chain, so g1 is free again but g2 is the newest.
        rawSlot(root, "s0.g2", String(c.now()), c.now());
      },
    });
    const dir = hookLedgerDir(APP, root);
    expect(existsSync(join(dir, "s0.g1"))).toBe(false);
    expect(existsSync(join(dir, "s1.g0"))).toBe(true);
    expect(n).toBe(2);
    expect(hookWindowCount(APP, { root, now: c.now })).toBe(2);
  });
});
