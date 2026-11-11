import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { home } from "../config.ts";

/** Start times and mtimes compare at second granularity; the plugin writes moments after its TUI starts. */
export const START_TOLERANCE_SECONDS = 2;

/** Where the TUI plugin writes `<tui pid>.json`: `{ pid, sessionIDs }`. */
export const opencodePresenceDir = () => join(home(), "opencode-tui");

export type PresenceDeps = {
  isRunning: (pid: number) => boolean;
  /** Epoch seconds the pid's current process started; null when it cannot be told. `stamp` names the file's version. */
  procStartEpoch: (pid: number, stamp?: string) => number | null;
  /** When set, only TUIs it accepts count (attached to one service, #1950). */
  accept?: (tuiPid: number) => boolean | null;
};

/**
 * Root session ids some running TUI has open. The plugin removes its file on
 * a clean exit only, so a TUI killed by a signal leaves one behind; once its
 * pid is reused, a file written before that process started counts for nothing.
 */
export function openSessions(dir: string, deps: PresenceDeps): Set<string> {
  const out = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const fn of names) {
    if (!/^\d+\.json$/.test(fn)) continue;
    let data: { pid?: unknown; sessionIDs?: unknown };
    let mtime: number;
    try {
      mtime = statSync(join(dir, fn)).mtimeMs / 1000;
      data = JSON.parse(readFileSync(join(dir, fn), "utf8"));
    } catch {
      continue;
    }
    const pid = data?.pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1)
      continue;
    if (!Array.isArray(data.sessionIDs)) continue;
    if (!deps.isRunning(pid)) continue;
    if (deps.accept && deps.accept(pid) !== true) continue;
    const started = deps.procStartEpoch(pid, String(mtime));
    if (started !== null && started > mtime + START_TOLERANCE_SECONDS) continue;
    for (const id of data.sessionIDs) if (typeof id === "string") out.add(id);
  }
  return out;
}

/** `ps -o lstart=` under `TZ=UTC LC_ALL=C` (procStartOf), as epoch seconds. */
export function lstartEpoch(lstart: string | null): number | null {
  if (!lstart) return null;
  const ms = Date.parse(`${lstart} UTC`);
  return Number.isNaN(ms) ? null : ms / 1000;
}

/**
 * Is `ref` open in an accepted TUI? Rows that do not list it cost no OS check,
 * and the scan stops at the first row that passes. `null` is unknown: no row
 * passed and at least one candidate could not be told (an OS read failed).
 */
export function openState(
  dir: string,
  deps: PresenceDeps,
  ref: string,
): boolean | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  let unknown = false;
  for (const fn of names) {
    if (!/^\d+\.json$/.test(fn)) continue;
    let data: { pid?: unknown; sessionIDs?: unknown };
    let mtime: number;
    try {
      mtime = statSync(join(dir, fn)).mtimeMs / 1000;
      data = JSON.parse(readFileSync(join(dir, fn), "utf8"));
    } catch {
      continue;
    }
    const pid = data?.pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1)
      continue;
    if (!Array.isArray(data.sessionIDs) || !data.sessionIDs.includes(ref))
      continue;
    if (!deps.isRunning(pid)) continue;
    const ok = deps.accept ? deps.accept(pid) : true;
    if (ok === null) {
      unknown = true;
      continue;
    }
    if (!ok) continue;
    const started = deps.procStartEpoch(pid, String(mtime));
    if (started !== null && started > mtime + START_TOLERANCE_SECONDS) continue;
    return true;
  }
  return unknown ? null : false;
}
