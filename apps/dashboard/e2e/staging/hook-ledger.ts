// #1254: the hook budget, shared by T19 (hook-pace.ts) and the red-line live
// suite (tests/redline/src/http.ts paceHook). It lives on the public side so
// the private suite imports it (never the other way), and it has no relative
// imports, so the suite can import it as a plain file.
//
// The server charges a /__test/* call whose hook key checks out to RL_HOOKS
// (600 a minute, keyed by install and IP); a wrong or absent key is charged to
// RL_ANON (30 a minute) first, and a limited call of either kind answers the
// same bare 404 as a wrong key. So each runner keeps one ledger per install
// (tmpdir, keyed by the target's app origin): every process on the runner that
// calls that install's hooks draws on it, and different installs never share
// one. The ledger only counts: a call that would be past the budget is refused
// at once (HookBudgetError), never waited for, so no suite sleeps on it.
//
// The ledger is a directory of slot files. A call takes slot n by linking a
// complete temp file (the call's time) to `s<n>.g<k>`: link fails EEXIST
// like an exclusive create, so of two processes taking the same free slot
// exactly one wins, nothing is ever read and rewritten, and a slot file
// never exists half written. A slot is free again once its newest
// generation is older than the window. A claim holds nothing open, so there
// is nothing to release: a call that throws after its claim keeps its slot
// (the server may well have charged it) and every other slot stays free.

import { createHash, randomBytes } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * RL_HOOKS in apps/server/wrangler.template.jsonc (and wrangler.staging.jsonc
 * and wrangler.test.jsonc): `"simple": { "limit": 600, "period": 60 }`.
 * test/hook-ledger.test.ts reads all three and fails if any differs.
 */
export const RL_HOOKS_LIMIT = 600;
export const RL_HOOKS_PERIOD_S = 60;
/**
 * Calls kept back from RL_HOOKS: /__test/* requests nothing counts (none
 * today) and Cloudflare's limiter being approximate (per location,
 * eventually consistent).
 */
export const HOOK_MARGIN = 30;
/** At most this many counted hook calls per install in any HOOK_WINDOW_MS. */
export const HOOK_LIMIT = RL_HOOKS_LIMIT - HOOK_MARGIN;
export const HOOK_WINDOW_MS = RL_HOOKS_PERIOD_S * 1000;

/** The ledger's key for a target: its app origin, hashed (as since #1261). */
export const hookLedgerKey = (app: string): string =>
  createHash("sha256").update(app).digest("hex").slice(0, 16);

/** The ledger directory for a target's app origin. */
export const hookLedgerDir = (app: string, root: string = tmpdir()): string =>
  join(root, `oa-redline-hooks-${hookLedgerKey(app)}`);

export class HookBudgetError extends Error {
  constructor(message: string) {
    super(`hook budget exhausted: ${message}`);
    this.name = "HookBudgetError";
  }
}

export interface PaceOpts {
  /** Ledger root (default tmpdir()). */
  root?: string;
  /** Keep this many calls of the budget free (a 404 that must be the key's). */
  reserve?: number;
  now?: () => number;
  /** Test seam: runs after a scan that found room, before the slot's create. */
  afterScan?: () => Promise<void>;
}

interface Slot {
  n: number;
  gen: number;
  at: number;
}

const SLOT = /^s(\d+)\.g(\d+)$/;

/** Ledger directories already announced by this process. */
const announced = new Set<string>();

/**
 * Parsed call times of write-once slot files (keyed by full path). Slot files
 * are linked in complete and never rewritten, so caching valid timestamps
 * avoids O(HOOK_LIMIT^2) file reads across a burst of claims in one process.
 */
const slotTimes = new Map<string, number>();
const SLOT_CACHE_LIMIT = 4096;

function cacheSlotTime(path: string, t: number): void {
  if (slotTimes.size >= SLOT_CACHE_LIMIT) slotTimes.clear();
  slotTimes.set(path, t);
}

/** A temp file older than this was left by a crash (takeSlot holds one for microseconds). */
export const STALE_TMP_MS = 3 * HOOK_WINDOW_MS;

/**
 * The ledger directory, created 0700; refused if it isn't ours. Once per
 * process: logged (two suites sharing a bucket must also share this
 * directory, the same os.tmpdir(), or their budgets split), and temp files
 * a crash left behind are removed (litter only: a scan never reads them).
 */
function ledgerDir(app: string, root: string): string {
  const dir = hookLedgerDir(app, root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (
    !st.isDirectory() ||
    (process.getuid && st.uid !== process.getuid()) ||
    (st.mode & 0o077) !== 0
  )
    throw new Error(`hook ledger ${dir}: not a private directory of ours`);
  if (!announced.has(dir)) {
    announced.add(dir);
    process.stderr.write(`hook budget: ledger ${dir}\n`);
    sweepTemps(dir, Date.now());
  }
  return dir;
}

/** Removes temp files older than STALE_TMP_MS (by mtime). */
function sweepTemps(dir: string, now: number): void {
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("tmp.")) continue;
    try {
      const p = join(dir, name);
      if (now - statSync(p).mtimeMs > STALE_TMP_MS) unlinkSync(p);
    } catch {}
  }
}

/**
 * A slot file's call time. Slots are linked in complete, so a time that
 * isn't a positive number at or before `now` (an empty file from an older
 * writer or a crash, a corrupt one, a clock that went back) falls back to
 * the file's mtime, so it still leaves the window a window after it was
 * made. Never later than `now`; `now` if even the stat fails.
 */
function callTime(path: string, now: number): number {
  const cached = slotTimes.get(path);
  if (cached !== undefined && cached <= now) return cached;
  try {
    const v = Number(readFileSync(path, "utf8"));
    if (Number.isFinite(v) && v > 0 && v <= now) {
      cacheSlotTime(path, v);
      return v;
    }
  } catch {}
  try {
    return Math.min(statSync(path).mtimeMs, now);
  } catch {
    return now;
  }
}

/** Each slot's newest generation and its call time. */
function scan(dir: string, now: number): Map<number, Slot> {
  const newest = new Map<number, { gen: number; name: string }>();
  for (const name of readdirSync(dir)) {
    const m = SLOT.exec(name);
    if (!m) continue;
    const n = Number(m[1]);
    const gen = Number(m[2]);
    const had = newest.get(n);
    if (had && had.gen >= gen) continue;
    newest.set(n, { gen, name });
  }
  const slots = new Map<number, Slot>();
  for (const [n, { gen, name }] of newest)
    slots.set(n, { n, gen, at: callTime(join(dir, name), now) });
  return slots;
}

/** Highest generation present for one slot, or -1 if none. */
function newestGen(dir: string, slot: number): number {
  let max = -1;
  const prefix = `s${slot}.g`;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue;
    const m = SLOT.exec(name);
    if (!m) continue;
    const gen = Number(m[2]);
    if (gen > max) max = gen;
  }
  return max;
}

/**
 * Links a complete temp file holding `t` to `name`: false if `name` exists
 * (another process took the slot). The temp file is always removed.
 */
function takeSlot(dir: string, name: string, t: number): boolean {
  const tmp = join(dir, `tmp.${process.pid}.${randomBytes(6).toString("hex")}`);
  const dest = join(dir, name);
  writeFileSync(tmp, String(t), { flag: "wx", mode: 0o600 });
  try {
    linkSync(tmp, dest);
    if (Number.isFinite(t) && t > 0) cacheSlotTime(dest, t);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return false;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

/** Calls in the window now (the newest generation of each fresh slot). */
export function hookWindowCount(
  app: string,
  o: Pick<PaceOpts, "root" | "now"> = {},
): number {
  const now = (o.now ?? Date.now)();
  const dir = ledgerDir(app, o.root ?? tmpdir());
  return [...scan(dir, now).values()].filter((s) => now - s.at < HOOK_WINDOW_MS)
    .length;
}

/**
 * Records a hook call to `app`, or throws HookBudgetError at once when the
 * budget (HOOK_LIMIT calls in HOOK_WINDOW_MS, less `reserve`) is spent: it
 * never waits. Returns the calls in the window, this one included.
 */
export async function claimHookSlot(
  app: string,
  o: PaceOpts = {},
): Promise<number> {
  const now = o.now ?? Date.now;
  const reserve = o.reserve ?? 0;
  const room = HOOK_LIMIT - reserve;
  if (room < 1) throw new Error("hook budget: reserve leaves no room");
  const dir = ledgerDir(app, o.root ?? tmpdir());
  for (;;) {
    const t = now();
    const slots = scan(dir, t);
    const fresh = [...slots.values()]
      .filter((s) => t - s.at < HOOK_WINDOW_MS)
      .map((s) => s.at)
      .sort((x, y) => x - y);
    // Count: the (fresh - room)-th oldest call must leave the window first.
    if (fresh.length >= room) {
      const wait = (fresh[fresh.length - room] as number) + HOOK_WINDOW_MS - t;
      throw new HookBudgetError(
        `${fresh.length} of ${HOOK_LIMIT} calls in the last ${HOOK_WINDOW_MS / 1000} s; ` +
          `the next fits in ${Math.ceil(wait / 1000)} s`,
      );
    }
    await o.afterScan?.();
    // Fewer than `room` fresh calls, so some slot below HOOK_LIMIT is free.
    for (let n = 0; n < HOOK_LIMIT; n++) {
      const s = slots.get(n);
      if (s && t - s.at < HOOK_WINDOW_MS) continue;
      const gen = s ? s.gen + 1 : 0;
      const name = `s${n}.g${gen}`;
      if (!takeSlot(dir, name, t)) break; // another process took it: scan again
      // A claim that stalled for windows can take a generation older than
      // the newest (one already unlinked): never counted, so not a call.
      if (newestGen(dir, n) !== gen) {
        const stale = join(dir, name);
        slotTimes.delete(stale);
        try {
          unlinkSync(stale);
        } catch {}
        break;
      }
      // Older generations of slot n are never read again. The one before
      // stays, so a claim that scanned it long ago still collides.
      if (gen >= 2) {
        const old = join(dir, `s${n}.g${gen - 2}`);
        slotTimes.delete(old);
        try {
          unlinkSync(old);
        } catch {}
      }
      return fresh.length + 1;
    }
  }
}

/**
 * Whether a bare hook 404 can be read as the hooks' own answer (hooks off,
 * wrong key) rather than the limiter's: never while the ledger is at or over the
 * budget, where an unpaced call could have tipped the server's bucket.
 */
export const hook404IsTheKeys = (windowCount: number): boolean =>
  windowCount < HOOK_LIMIT;
