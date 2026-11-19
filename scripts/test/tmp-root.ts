/**
 * Vitest globalSetup: one temp root per test run, deleted when the run ends.
 *
 * Tests make a temp dir for nearly every case (`mkdtempSync(join(tmpdir(),
 * ...))`, 270-odd places) and most never remove it. On a machine that runs
 * the suites all day that left over a million folders in the system temp
 * dir, which slows every later mkdtemp and listing.
 *
 * So the run gets its own root inside the system temp dir and TMPDIR (and
 * TMP/TEMP) point at it before any worker starts. Workers and every child
 * they spawn inherit it, so `os.tmpdir()`, `mktemp` and friends all land
 * inside the root, and teardown removes the root in one go. No test has to
 * clean up after itself, and a test that forgets costs nothing.
 *
 * A run that is killed cannot run teardown, so setup also sweeps roots that
 * an earlier run left behind more than a day ago.
 *
 * The root's name is short on purpose: Unix socket paths are capped near 104
 * bytes and several tests put sockets a few folders deep.
 */
import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The run root's name prefix inside the system temp dir. */
export const RUN_ROOT_PREFIX = "vt-";
/** A root older than this was left by a run that never reached teardown. */
export const STALE_MS = 24 * 60 * 60 * 1000;

const VARS = ["TMPDIR", "TMP", "TEMP"] as const;

/** Removes run roots under `base` last touched more than STALE_MS ago. Never throws. */
export function sweepStale(base: string, now = Date.now()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!/^vt-[A-Za-z0-9]{6}$/.test(name)) continue;
    const dir = join(base, name);
    try {
      const st = statSync(dir);
      if (!st.isDirectory() || now - st.mtimeMs < STALE_MS) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // Another run's, or already gone: leave it.
    }
  }
  return removed;
}

export default function setup(): () => void {
  const base = tmpdir();
  const before = VARS.map((k) => [k, process.env[k]] as const);
  sweepStale(base);
  // The real path: on macOS the temp dir sits behind a symlink (/var to
  // /private/var), and code that compares paths against os.tmpdir() should
  // not have to care.
  const root = realpathSync(mkdtempSync(join(base, RUN_ROOT_PREFIX)));
  for (const k of VARS) process.env[k] = root;
  return () => {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A child may still hold a file open; the next run's sweep takes it.
    }
  };
}
