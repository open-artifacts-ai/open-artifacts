import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { notASession, peerTokenFor } from "@oa/bus-adapter-claude-code";
import { AgentRefSchema } from "@oa/bus-protocol";

export type LiveClaude = {
  ref: string;
  name: string;
  /** The file names the session (`/rename`); false when `name` is the generated `claude-<pid>`. */
  named: boolean;
  pid: number;
  socketPath: string;
  cwd: string;
};

export type ClaudeLivenessDeps = {
  dir: string;
  /** `stamp` identifies the session file's version; a cache re-asks when it changes. */
  procStart: (pid: number, stamp?: string) => string | null;
  isRunning: (pid: number) => boolean;
  sha256?: (s: string) => string;
};

type SessionFile = LiveClaude & { procStart: string; stamp: string };

/** Every well-formed session file, without asking the OS anything. */
function sessionFiles(dir: string): SessionFile[] {
  const out: SessionFile[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const fn of names) {
    if (!/^\d+\.json$/.test(fn)) continue;
    let rec: Record<string, unknown>;
    let mtime: number;
    try {
      mtime = statSync(join(dir, fn)).mtimeMs;
      rec = JSON.parse(readFileSync(join(dir, fn), "utf8"));
    } catch {
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
      name:
        typeof rec.name === "string" && rec.name ? rec.name : `claude-${pid}`,
      named: typeof rec.name === "string" && rec.name !== "",
      pid,
      socketPath:
        typeof rec.messagingSocketPath === "string"
          ? rec.messagingSocketPath
          : "",
      cwd: typeof rec.cwd === "string" ? rec.cwd : "",
      procStart: rec.procStart,
      stamp: `${rec.procStart}\u0000${mtime}`,
    });
  }
  return out;
}

const alive = (s: SessionFile, deps: ClaudeLivenessDeps) =>
  deps.isRunning(s.pid) && deps.procStart(s.pid, s.stamp) === s.procStart;

const strip = ({ procStart: _, stamp: __, ...s }: SessionFile): LiveClaude => s;

/**
 * Claude sessions that are running now, from `~/.claude/sessions`: the process
 * is up and its start time matches. One with no socket (cross-session
 * messaging off) can still send; it just cannot receive.
 */
export function liveClaudeSessions(deps: ClaudeLivenessDeps): LiveClaude[] {
  return sessionFiles(deps.dir)
    .filter((s) => alive(s, deps))
    .map(strip);
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

/**
 * At most one `ps` per pid per sync interval. A stopped pid, a session file
 * rewritten (new stamp) or an entry `ttlMs` old asks again, so a pid killed
 * and reused between two ticks, its file untouched, is not masked.
 */
export function cachedProcStart(
  procStart: (pid: number) => string | null,
  running: (pid: number) => boolean,
  opts: { ttlMs?: number; now?: () => number } = {},
): (pid: number, stamp?: string) => string | null {
  const ttl = opts.ttlMs ?? 2000;
  const now = opts.now ?? Date.now;
  const cache = new Map<
    number,
    { start: string; stamp?: string; at: number }
  >();
  return (pid, stamp) => {
    if (!running(pid)) {
      cache.delete(pid);
      return null;
    }
    const hit = cache.get(pid);
    if (hit && hit.stamp === stamp && now() - hit.at < ttl) return hit.start;
    const start = procStart(pid);
    if (start === null) cache.delete(pid);
    else cache.set(pid, { start, stamp, at: now() });
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
