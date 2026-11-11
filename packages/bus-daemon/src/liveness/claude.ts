import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  notASession,
  ProcStartUnknownError,
  peerTokenFor,
} from "@oa/bus-adapter-claude-code";
import { AgentRefSchema } from "@oa/bus-protocol";

export type LiveClaude = {
  ref: string;
  name: string;
  pid: number;
  socketPath: string;
  cwd: string;
  /** The process start the session file recorded: tells a reused pid from the session's own. */
  procStart: string;
  /** #2110: running, but its start time could not be read: unknown, kept live for a bounded grace by the caller. */
  unknown?: true;
};

export type ClaudeLivenessDeps = {
  dir: string;
  /** `stamp` identifies the session file's version; a cache re-asks when it changes. */
  procStart: (pid: number, stamp?: string) => string | null;
  isRunning: (pid: number) => boolean;
  sha256?: (s: string) => string;
};

type SessionFile = LiveClaude & { stamp: string };

/** Every well-formed session file, without asking the OS anything, and the pids whose file exists but cannot be read or parsed right now (a rewrite in flight: unknown, not gone). */
function scanSessions(dir: string): {
  files: SessionFile[];
  unreadable: Set<number>;
} {
  const out: SessionFile[] = [];
  const unreadable = new Set<number>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { files: out, unreadable };
  }
  for (const fn of names) {
    const m = /^(\d+)\.json$/.exec(fn);
    if (!m) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(readFileSync(join(dir, fn), "utf8"));
    } catch {
      unreadable.add(Number(m[1]));
      continue;
    }
    const pid = Number(rec?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    if (notASession(rec)) continue;
    if (!AgentRefSchema.safeParse(rec.sessionId).success) continue;
    // Without procStart a reused pid is indistinguishable from the session.
    if (typeof rec.procStart !== "string") continue;
    out.push({
      ref: String(rec.sessionId),
      name: typeof rec.name === "string" ? rec.name : `claude-${pid}`,
      pid,
      socketPath:
        typeof rec.messagingSocketPath === "string"
          ? rec.messagingSocketPath
          : "",
      cwd: typeof rec.cwd === "string" ? rec.cwd : "",
      procStart: rec.procStart,
      // Not the mtime: live sessions rewrite their file every 15-60 s. A reused pid writes a new procStart.
      stamp: rec.procStart,
    });
  }
  return { files: out, unreadable };
}

const sessionFiles = (dir: string) => scanSessions(dir).files;

/**
 * #2110: closed only on positive evidence. A pid that is not running, or a
 * different start time (a reused pid), is gone; a running pid whose start time
 * could not be read (null) is unknown.
 */
const aliveState = (
  s: SessionFile,
  deps: ClaudeLivenessDeps,
): "yes" | "unknown" | "no" => {
  if (!deps.isRunning(s.pid)) return "no";
  const start = deps.procStart(s.pid, s.stamp);
  if (start === null) return "unknown";
  return start === s.procStart ? "yes" : "no";
};
const alive = (s: SessionFile, deps: ClaudeLivenessDeps) =>
  aliveState(s, deps) !== "no";

const strip = ({ stamp: _, ...s }: SessionFile): LiveClaude => s;

function liveOf(files: SessionFile[], deps: ClaudeLivenessDeps): LiveClaude[] {
  const out: LiveClaude[] = [];
  for (const s of files) {
    const st = aliveState(s, deps);
    if (st === "no") continue;
    out.push(st === "unknown" ? { ...strip(s), unknown: true } : strip(s));
  }
  return out;
}

/** Every live session file, one per process: a membership test, never deduped. */
export function liveClaudeFiles(deps: ClaudeLivenessDeps): LiveClaude[] {
  return liveOf(sessionFiles(deps.dir), deps);
}

/**
 * Claude sessions that are running now, from `~/.claude/sessions`: the process
 * is up and its start time matches (or could not be read: `unknown`). One with
 * no socket (cross-session messaging off) can still send; it just cannot
 * receive. `unreadable` is the pids whose file could not be read this pass.
 */
export function liveClaudeScan(
  deps: ClaudeLivenessDeps,
  /** The pid the caller already knows for a ref (its record's, a hello's): that file wins. */
  preferPid?: (ref: string) => number | undefined,
): { live: LiveClaude[]; unreadable: Set<number> } {
  // One file per session: a headless `claude --resume` shares the id, and
  // its nameless file must not stand for the session (#1635).
  const byRef = new Map<string, LiveClaude>();
  const rank = (s: LiveClaude) =>
    (s.pid === preferPid?.(s.ref) ? 4 : 0) +
    (s.socketPath !== "" ? 2 : 0) +
    (s.name !== `claude-${s.pid}` ? 1 : 0);
  const scan = scanSessions(deps.dir);
  for (const s of liveOf(scan.files, deps)) {
    const cur = byRef.get(s.ref);
    if (
      !cur ||
      rank(s) > rank(cur) ||
      (rank(s) === rank(cur) && s.pid < cur.pid)
    )
      byRef.set(s.ref, s);
  }
  return { live: [...byRef.values()], unreadable: scan.unreadable };
}

export function liveClaudeSessions(
  deps: ClaudeLivenessDeps,
  preferPid?: (ref: string) => number | undefined,
): LiveClaude[] {
  return liveClaudeScan(deps, preferPid).live;
}

/** Where to inject for one session, read fresh each time; null when it is gone. Asks the OS about that session only. */
export function claudeTarget(
  ref: string,
  deps: ClaudeLivenessDeps,
): { socketPath: string; peerToken: string } | null {
  const s = sessionFiles(deps.dir).find(
    (x) => x.ref === ref && x.socketPath && alive(x, deps),
  );
  if (!s) return null;
  const peerToken = peerTokenFor(
    s.pid,
    s.socketPath,
    deps.dir,
    s.procStart,
    deps.sha256,
  );
  return peerToken ? { socketPath: s.socketPath, peerToken } : null;
}

/** A live pid's start time never changes, so a long TTL is safe. */
export const PROC_START_TTL_MS = 60_000;

/**
 * At most one `ps` per pid per `ttlMs` (60 s by default). A stopped pid
 * (`running()` is false) or a session file rewritten (new stamp) asks again at
 * once. A pid killed and reused with its file untouched is caught by
 * `running()` only until the reuse, so it can go unnoticed for up to `ttlMs`.
 * A `ps` that times out is "unknown", not "gone": the last known start stays.
 */
export function cachedProcStart(
  procStart: (pid: number) => string | null,
  running: (pid: number) => boolean,
  opts: { ttlMs?: number; jitter?: number; now?: () => number } = {},
): (pid: number, stamp?: string) => string | null {
  const ttl = opts.ttlMs ?? PROC_START_TTL_MS;
  const now = opts.now ?? Date.now;
  const cache = new Map<
    number,
    { start: string; stamp?: string; at: number }
  >();
  const lastKnown = new Map<number, string>();
  return (pid, stamp) => {
    if (!running(pid)) {
      cache.delete(pid);
      lastKnown.delete(pid);
      return null;
    }
    const hit = cache.get(pid);
    // Spread by pid so entries made on one tick do not all expire on the same later tick.
    const life = ttl + (pid % 16) * ((ttl * (opts.jitter ?? 0.5)) / 16);
    if (hit && hit.stamp === stamp && now() - hit.at < life) return hit.start;
    let start: string | null;
    try {
      start = procStart(pid);
    } catch (e) {
      if (e instanceof ProcStartUnknownError) return lastKnown.get(pid) ?? null;
      throw e;
    }
    if (start === null) {
      cache.delete(pid);
      lastKnown.delete(pid);
    } else {
      cache.set(pid, { start, stamp, at: now() });
      lastKnown.set(pid, start);
    }
    return start;
  };
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
