import {
  chmodSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { stateFile } from "./layout.ts";
import { emptyPolicy, type PolicyState, parseVersion } from "./policy.ts";

/**
 * The policy's half of update.json (#2552). Layout keys (armed, current,
 * previous) and keys this file does not know are kept on every write.
 */

const rawState = (home: string): Record<string, unknown> => {
  try {
    const j: unknown = JSON.parse(readFileSync(stateFile(home), "utf8"));
    if (j !== null && typeof j === "object" && !Array.isArray(j))
      return j as Record<string, unknown>;
  } catch {
    // none yet, or unreadable: start empty
  }
  return {};
};

const ver = (v: unknown) => (parseVersion(v) ? (v as string) : undefined);

export function readPolicy(home: string): PolicyState {
  const j = rawState(home);
  const s = emptyPolicy();
  s.off = j.off === true;
  const newest = ver(j.newestRun);
  const prev = ver(j.previous);
  const cur = ver(j.current);
  if (newest) s.newestRun = newest;
  if (prev) s.previous = prev;
  if (cur) s.current = cur;
  if (Array.isArray(j.failed))
    s.failed = j.failed.filter((v): v is string => ver(v) !== undefined);
  if (typeof j.lastAt === "number" && Number.isFinite(j.lastAt))
    s.lastAt = j.lastAt;
  const st = j.staged as { version?: unknown; readySince?: unknown } | null;
  if (
    st &&
    typeof st === "object" &&
    ver(st.version) &&
    typeof st.readySince === "number" &&
    Number.isFinite(st.readySince)
  )
    s.staged = { version: st.version as string, readySince: st.readySince };
  if (
    j.notified &&
    typeof j.notified === "object" &&
    !Array.isArray(j.notified)
  )
    for (const [k, v] of Object.entries(j.notified))
      if (ver(k) && Array.isArray(v))
        s.notified[k] = v.filter((x): x is string => typeof x === "string");
  s.introShown = j.introShown === true;
  s.needsYou = j.needsYou === true;
  return s;
}

/** The keys this module owns; the layout's are never written from here. */
const OWNED = [
  "off",
  "newestRun",
  "failed",
  "lastAt",
  "staged",
  "notified",
  "introShown",
  "needsYou",
] as const;

export function writePolicy(home: string, s: PolicyState): void {
  const next: Record<string, unknown> = { ...rawState(home) };
  for (const k of OWNED) {
    const v = s[k];
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  const tmp = `${stateFile(home)}.${process.pid}.policy.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, stateFile(home));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * The only writer of `off`. Called by the local `oa-bus auto-update` command
 * and nothing else: a test checks no other source file imports it.
 */
export function setOff(home: string, off: boolean): PolicyState {
  const s = readPolicy(home);
  s.off = off;
  writePolicy(home, s);
  return s;
}

/** Records an attempt (a step-back too). lastAt never moves backward. */
export function recordAttempt(home: string, now: number): PolicyState {
  const s = readPolicy(home);
  s.lastAt = Math.max(now, s.lastAt ?? 0);
  writePolicy(home, s);
  return s;
}

/** A failed or refused version is remembered and never retried. */
export function markFailed(home: string, version: string): PolicyState {
  const s = readPolicy(home);
  if (parseVersion(version) && !s.failed.includes(version))
    s.failed.push(version);
  if (s.staged?.version === version) delete s.staged;
  writePolicy(home, s);
  return s;
}

/** Persists "<kind> sent for <version>" before the send; false if already. */
export function markNotified(
  home: string,
  version: string,
  kind: "ready" | "failed" | "refused",
): boolean {
  const s = readPolicy(home);
  if (!parseVersion(version)) return false;
  const list = s.notified[version] ?? [];
  if (list.includes(kind)) return false;
  s.notified[version] = [...list, kind];
  writePolicy(home, s);
  return true;
}

export function setStaged(
  home: string,
  version: string,
  now: number,
): PolicyState {
  const s = readPolicy(home);
  if (parseVersion(version)) s.staged = { version, readySince: now };
  writePolicy(home, s);
  return s;
}
