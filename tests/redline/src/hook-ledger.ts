// #1254: the hook budget, shared by the red-line live suite (src/http.ts
// paceHook) and T19 (apps/dashboard/e2e/staging). No relative imports: T19
// imports this file from the dashboard too.
//
// The server charges every /__test/* call to RL_ANON before it reads the
// hook key (apps/server/src/test-hooks/index.ts), keyed by install and IP,
// and a limited call answers the same bare 404 as a wrong key. So each
// runner keeps one ledger per install (tmpdir, keyed by the target's app
// origin): every process on the runner that calls that install's hooks
// draws on it, and different installs never share one.
//
// The ledger is a directory of slot files. A call takes slot n by creating
// `s<n>.g<k>` with an exclusive create (O_EXCL): of two processes taking the
// same free slot, exactly one wins, and nothing is ever read and rewritten.
// A slot is free again once its newest generation is older than the window.
// The file holds the call's time. A claim holds nothing open, so there is
// nothing to release: a call that throws after its claim keeps its slot
// (the server may well have charged it) and every other slot stays free.

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * RL_ANON in apps/server/wrangler.template.jsonc (and wrangler.test.jsonc,
 * which the local pair uses): `"simple": { "limit": 30, "period": 60 }`.
 * test/hook-ledger.test.ts reads both files and fails if either differs.
 */
export const RL_ANON_LIMIT = 30;
export const RL_ANON_PERIOD_S = 60;
/**
 * Calls kept back from RL_ANON: /__test/* requests nothing paces (none
 * today) and Cloudflare's limiter being approximate (per location,
 * eventually consistent).
 */
export const HOOK_MARGIN = 5;
/** At most this many paced hook calls per install in any HOOK_WINDOW_MS. */
export const HOOK_LIMIT = RL_ANON_LIMIT - HOOK_MARGIN;
export const HOOK_WINDOW_MS = RL_ANON_PERIOD_S * 1000;
/** T19's spread: at most one call per this gap, so a burst never fills the window. */
export const HOOK_GAP_MS = Math.ceil(HOOK_WINDOW_MS / HOOK_LIMIT);
/** Added to every computed wait, so the freed call is past the window's edge. */
const EDGE_MS = 100;

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
  /** Epoch ms by which the call must be made; past it, HookBudgetError. */
  deadline?: number;
  /** Keep this many calls of the budget free (a 404 that must be the key's). */
  reserve?: number;
  /** At most one call per HOOK_GAP_MS (T19), besides the window. */
  spread?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: runs after a scan that found room, before the slot's create. */
  afterScan?: () => Promise<void>;
}

interface Slot {
  n: number;
  gen: number;
  at: number;
}

const SLOT = /^s(\d+)\.g(\d+)$/;

/** The ledger directory, created 0700; refused if it isn't ours. */
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
  return dir;
}

/** Each slot's newest generation and its call time. */
function scan(dir: string, now: number): Map<number, Slot> {
  const slots = new Map<number, Slot>();
  for (const name of readdirSync(dir)) {
    const m = SLOT.exec(name);
    if (!m) continue;
    const n = Number(m[1]);
    const gen = Number(m[2]);
    const had = slots.get(n);
    if (had && had.gen >= gen) continue;
    let at = now;
    try {
      const v = Number(readFileSync(join(dir, name), "utf8"));
      // Empty (its creator is still writing) or from the future: fresh.
      if (Number.isFinite(v) && v > 0 && v <= now) at = v;
    } catch {}
    slots.set(n, { n, gen, at });
  }
  return slots;
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
 * Waits until a hook call to `app` fits the budget, then records it. Waits
 * are computed from the ledger (the oldest call in the window, and with
 * `spread` the newest), never fixed. Returns the calls in the window,
 * this one included. Throws HookBudgetError when the wait would pass
 * `deadline`.
 */
export async function claimHookSlot(
  app: string,
  o: PaceOpts = {},
): Promise<number> {
  const now = o.now ?? Date.now;
  const sleep =
    o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
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
    const newest = fresh.at(-1);
    const waits: number[] = [];
    // Count: the (fresh - room)-th oldest call must leave the window.
    if (fresh.length >= room)
      waits.push(
        (fresh[fresh.length - room] as number) + HOOK_WINDOW_MS - t + EDGE_MS,
      );
    if (o.spread && newest !== undefined && t - newest < HOOK_GAP_MS)
      waits.push(newest + HOOK_GAP_MS - t);
    if (waits.length === 0) {
      await o.afterScan?.();
      // Fewer than `room` fresh calls, so some slot below HOOK_LIMIT is free.
      for (let n = 0; n < HOOK_LIMIT; n++) {
        const s = slots.get(n);
        if (s && t - s.at < HOOK_WINDOW_MS) continue;
        const gen = s ? s.gen + 1 : 0;
        try {
          writeFileSync(join(dir, `s${n}.g${gen}`), String(t), {
            flag: "wx",
            mode: 0o600,
          });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          break; // another process took it: scan again
        }
        // Older generations of slot n are never read again. The one before
        // stays, so a claim that scanned it long ago still collides.
        if (gen >= 2)
          try {
            unlinkSync(join(dir, `s${n}.g${gen - 2}`));
          } catch {}
        return fresh.length + 1;
      }
      continue;
    }
    const wait = Math.max(1, ...waits);
    if (o.deadline !== undefined && t + wait > o.deadline)
      throw new HookBudgetError(
        `${fresh.length} of ${HOOK_LIMIT} calls in the last ${HOOK_WINDOW_MS / 1000} s; ` +
          `the next fits in ${Math.ceil(wait / 1000)} s, past this call's deadline`,
      );
    await sleep(wait);
  }
}

/**
 * Whether a bare hook 404 can be read as the hooks' own answer (hooks off,
 * wrong key) rather than RL_ANON's: never while the ledger is at or over the
 * budget, where an unpaced call could have tipped the server's bucket.
 */
export const hook404IsTheKeys = (windowCount: number): boolean =>
  windowCount < HOOK_LIMIT;

/**
 * Waits until no paced call to `app` is in the window (T19's setup, so its
 * spread calls start on an empty budget after the live suite). The wait is
 * computed from the newest call. Throws HookBudgetError past `deadline`.
 */
export async function waitHookWindowClear(
  app: string,
  o: Pick<PaceOpts, "root" | "deadline" | "now" | "sleep"> = {},
): Promise<void> {
  const now = o.now ?? Date.now;
  const sleep =
    o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dir = ledgerDir(app, o.root ?? tmpdir());
  for (;;) {
    const t = now();
    const fresh = [...scan(dir, t).values()]
      .map((s) => s.at)
      .filter((at) => t - at < HOOK_WINDOW_MS);
    if (fresh.length === 0) return;
    const wait = Math.max(...fresh) + HOOK_WINDOW_MS - t + EDGE_MS;
    if (o.deadline !== undefined && t + wait > o.deadline)
      throw new HookBudgetError(
        `${fresh.length} calls still in the window; it clears in ${Math.ceil(wait / 1000)} s, past the deadline`,
      );
    await sleep(wait);
  }
}
