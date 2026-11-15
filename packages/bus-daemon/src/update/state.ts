import {
  chmodSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { stateFile } from "./layout.ts";
import {
  compareVersions,
  emptyPolicy,
  MAX_LIST,
  type PolicyState,
  parseVersion,
} from "./policy.ts";

/**
 * The policy's half of update.json (#2552). Layout keys (armed, current,
 * previous) and keys this file does not know are kept on every write.
 *
 * Keys only the local CLI sets (`off`, `introShown`) and the hand-run install
 * sets (`armed`) are never written from a state object: every other writer
 * re-reads the file at write time and keeps their current values.
 */

type Raw =
  | { kind: "missing" }
  | { kind: "bad" }
  | { kind: "ok"; j: Record<string, unknown> };

function load(home: string): Raw {
  let text: string;
  try {
    text = readFileSync(stateFile(home), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "bad" };
  }
  try {
    const j: unknown = JSON.parse(text);
    if (j !== null && typeof j === "object" && !Array.isArray(j))
      return { kind: "ok", j: j as Record<string, unknown> };
  } catch {
    // fall through
  }
  return { kind: "bad" };
}

/** A staged folder's file hashes: relative path to 64 hex digits. */
export const MAX_MANIFEST = 5000;
function readManifest(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const e = Object.entries(v);
  if (e.length === 0 || e.length > MAX_MANIFEST) return undefined;
  const out: Record<string, string> = {};
  for (const [k, h] of e) {
    if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) return undefined;
    out[k] = h;
  }
  return out;
}

const ver = (v: unknown) => (parseVersion(v) ? (v as string) : undefined);
const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * A missing file reads as not armed; a file that exists but cannot be read
 * or parsed reads as `unreadable`: never defaults that could reset a guard.
 */
export function readPolicy(home: string): PolicyState {
  const r = load(home);
  const s = emptyPolicy();
  if (r.kind === "bad") {
    s.unreadable = true;
    return s;
  }
  if (r.kind === "missing") return s;
  const j = r.j;
  s.armed = j.armed === true;
  s.off = j.off === true;
  const newest = ver(j.newestRun);
  const prev = ver(j.previous);
  const cur = ver(j.current);
  if (newest) s.newestRun = newest;
  if (prev) s.previous = prev;
  if (cur) s.current = cur;
  if (Array.isArray(j.failed))
    s.failed = j.failed
      .filter((v): v is string => ver(v) !== undefined)
      .slice(-MAX_LIST);
  const ref = j.refused;
  if (ref && typeof ref === "object" && !Array.isArray(ref))
    for (const [k, v] of Object.entries(ref).slice(-MAX_LIST)) {
      const e = v as { at?: unknown; count?: unknown } | null;
      const at = num(e?.at);
      const count = num(e?.count);
      if (ver(k) && at !== undefined && count !== undefined && count >= 1)
        s.refused[k] = { at, count };
    }
  const lastAt = num(j.lastAt);
  if (lastAt !== undefined) s.lastAt = lastAt;
  const st = j.staged as {
    version?: unknown;
    readySince?: unknown;
    manifest?: unknown;
  } | null;
  const rs = num(st?.readySince);
  if (st && typeof st === "object" && ver(st.version) && rs !== undefined) {
    s.staged = { version: st.version as string, readySince: rs };
    const m = readManifest(st.manifest);
    if (m) s.staged.manifest = m;
  }
  const pd = j.pending as Record<string, unknown> | null;
  if (pd && typeof pd === "object" && !Array.isArray(pd)) {
    const at = num(pd.startedAt);
    const attempts = num(pd.attempts);
    if (
      ver(pd.from) &&
      ver(pd.to) &&
      at !== undefined &&
      attempts !== undefined
    )
      s.pending = {
        from: pd.from as string,
        to: pd.to as string,
        startedAt: at,
        attempts,
      };
  }
  if (
    j.notified &&
    typeof j.notified === "object" &&
    !Array.isArray(j.notified)
  )
    for (const [k, v] of Object.entries(j.notified).slice(-MAX_LIST))
      if (ver(k) && Array.isArray(v))
        s.notified[k] = v.filter((x): x is string => typeof x === "string");
  s.introShown = j.introShown === true;
  s.needsYou = j.needsYou === true;
  return s;
}

/** Atomic 0600 write of a whole update.json body. */
function put(home: string, next: Record<string, unknown>): void {
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

/** The keys a state object may write; `off`, `introShown`, `armed` are not here. */
const OWNED = [
  "newestRun",
  "failed",
  "refused",
  "lastAt",
  "staged",
  "pending",
  "notified",
  "needsYou",
] as const;

const capKeys = <T>(o: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(o).slice(-MAX_LIST));

/**
 * Writes the policy's own keys over what is on disk now. `off`, `introShown`
 * and `armed` keep their on-disk values, so a stale state object can never
 * clear `off`. Refuses to write over a file it cannot read.
 */
export function writePolicy(home: string, s: PolicyState): void {
  const r = load(home);
  if (r.kind === "bad") throw new Error("update.json is unreadable");
  const next: Record<string, unknown> = r.kind === "ok" ? { ...r.j } : {};
  const capped: PolicyState = {
    ...s,
    failed: s.failed.slice(-MAX_LIST),
    refused: capKeys(s.refused),
    notified: capKeys(s.notified),
  };
  for (const k of OWNED) {
    const v = capped[k];
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  put(home, next);
}

/** Sets one CLI-only key, touching nothing else. Overwrites an unreadable file. */
function setCliKey(home: string, key: "off" | "introShown", v: boolean): void {
  const r = load(home);
  const base = r.kind === "ok" ? { ...r.j } : {};
  base[key] = v;
  put(home, base);
}

/**
 * The only writer of `off`. Called by the local `oa-bus auto-update` command
 * and nothing else: a test checks no other source file imports it.
 */
export function setOff(home: string, off: boolean): PolicyState {
  setCliKey(home, "off", off);
  return readPolicy(home);
}

/** CLI only: the first-time line has been shown. */
export function setIntroShown(home: string): void {
  setCliKey(home, "introShown", true);
}

export const editPolicy = (
  home: string,
  f: (s: PolicyState) => void,
): PolicyState => {
  const s = readPolicy(home);
  f(s);
  writePolicy(home, s);
  return readPolicy(home);
};

/** Records an attempt (a step-back too). lastAt never moves backward. */
export const recordAttempt = (home: string, now: number) =>
  editPolicy(home, (s) => {
    s.lastAt = Math.max(now, s.lastAt ?? 0);
  });

/** Failed to start: remembered and never retried. */
export const markFailed = (home: string, version: string) =>
  editPolicy(home, (s) => {
    if (!parseVersion(version)) return;
    if (!s.failed.includes(version)) s.failed.push(version);
    if (s.staged?.version === version) delete s.staged;
  });

/** Proof refused: reported loudly, retried later with a growing backoff. */
export const markRefused = (home: string, version: string, now: number) =>
  editPolicy(home, (s) => {
    if (!parseVersion(version)) return;
    const count = (s.refused[version]?.count ?? 0) + 1;
    delete s.refused[version];
    s.refused[version] = { at: now, count };
    if (s.staged?.version === version) delete s.staged;
  });

/** Persists "<kind> sent for <version>" before the send; false if already. */
export function markNotified(
  home: string,
  version: string,
  kind: "ready" | "failed" | "refused",
): boolean {
  if (!parseVersion(version)) return false;
  let fresh = false;
  editPolicy(home, (s) => {
    const list = s.notified[version] ?? [];
    if (list.includes(kind)) return;
    fresh = true;
    delete s.notified[version];
    s.notified[version] = [...list, kind];
  });
  return fresh;
}

export const setStaged = (
  home: string,
  version: string,
  now: number,
  manifest?: Record<string, string>,
) =>
  editPolicy(home, (s) => {
    if (parseVersion(version))
      s.staged = {
        version,
        readySince: now,
        ...(manifest ? { manifest } : {}),
      };
  });

export const clearStaged = (home: string) =>
  editPolicy(home, (s) => {
    delete s.staged;
  });

/** A switch is about to happen: the self-check and the rescue shim read it. */
export const setPending = (
  home: string,
  p: { from: string; to: string; startedAt: number },
) =>
  editPolicy(home, (s) => {
    if (parseVersion(p.from) && parseVersion(p.to))
      s.pending = { ...p, attempts: 0 };
  });

export const clearPending = (home: string) =>
  editPolicy(home, (s) => {
    delete s.pending;
  });

/** The release wants something this build cannot do alone: "Update needs you". */
export const setNeedsYou = (home: string, v: boolean) =>
  editPolicy(home, (s) => {
    s.needsYou = v;
  });

/** Raises newestRun to `version` when it is newer; never lowers it. */
export const noteRun = (home: string, version: string) =>
  editPolicy(home, (s) => {
    if (
      parseVersion(version) &&
      (s.newestRun === undefined || compareVersions(version, s.newestRun) === 1)
    )
      s.newestRun = version;
  });

/**
 * `oa-bus update` leaves a request for the daemon to install the staged
 * version. CLI-only key, like `off`: the daemon only clears it.
 */
export function requestInstall(
  home: string,
  version: string,
  at: number,
): void {
  const r = load(home);
  const base = r.kind === "ok" ? { ...r.j } : {};
  base.installRequest = { version, at };
  put(home, base);
}

export function readInstallRequest(
  home: string,
): { version: string; at: number } | undefined {
  const r = load(home);
  if (r.kind !== "ok") return undefined;
  const q = r.j.installRequest as { version?: unknown; at?: unknown } | null;
  const at = num(q?.at);
  return q && ver(q.version) && at !== undefined
    ? { version: q.version as string, at }
    : undefined;
}

export function clearInstallRequest(home: string): void {
  const r = load(home);
  if (r.kind !== "ok" || !("installRequest" in r.j)) return;
  const next = { ...r.j };
  delete next.installRequest;
  put(home, next);
}
