import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CLIENT_VERSION, fitName, Hello, systemTool } from "@oa/bus-ipc";

export type ClaudeSession = {
  pid: number;
  sessionId: string;
  /** Null when cross-session messaging is off: the session can send, not receive. */
  socketPath: string | null;
  peerToken: string | null;
  name: string;
};

export type SessionDeps = {
  sessionsDir: string;
  ancestors: (pid: number) => number[];
  procStart: (pid: number) => string | null;
  sha256?: (s: string) => string;
};

/** The one place the Claude sessions dir is chosen: MCP server, attestation and liveness. */
export const claudeSessionsDir = (
  env: Record<string, string | undefined> = process.env,
): string =>
  env.OA_BUS_CLAUDE_SESSIONS_DIR || join(homedir(), ".claude", "sessions");

/** OA_BUS_HOME, absolute; empty means unset. Daemon, CLI and MCP servers all read it here. */
export const busHome = (
  env: Record<string, string | undefined> = process.env,
): string => resolve(env.OA_BUS_HOME || join(homedir(), ".oa-bus"));

/**
 * A session file that is not a session: a parked background job, or a peer
 * agent-bus published. Liveness, attestation and findSession all skip it alike.
 */
export const notASession = (rec: Record<string, unknown>): boolean =>
  rec.parkedJobId !== undefined || Boolean(rec.agentBus);

/**
 * An ancestor's `<pid>.json`: "none" only when there is no such file. One that
 * exists but cannot be read, parsed, or has no sessionId (Claude may be mid
 * write) is "unreadable": the walk stops there, never claiming an outer session.
 */
export function readSessionFile(
  dir: string,
  pid: number,
):
  | { state: "none" }
  | { state: "unreadable" }
  | { state: "ok"; rec: Record<string, unknown> & { sessionId: string } } {
  let text: string;
  try {
    text = readFileSync(join(dir, `${pid}.json`), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "none" }
      : { state: "unreadable" };
  }
  try {
    const rec = JSON.parse(text) as Record<string, unknown> | null;
    if (typeof rec?.sessionId === "string")
      return { state: "ok", rec: rec as typeof rec & { sessionId: string } };
  } catch {}
  return { state: "unreadable" };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * The peerToken Claude published for this pid and socket, or null. The key
 * must name the session's own procStart: one left by an earlier process is stale.
 */
export function peerTokenFor(
  pid: number,
  socketPath: string,
  dir: string,
  procStart: string,
  hash: (s: string) => string = sha256,
): string | null {
  try {
    const key = JSON.parse(
      readFileSync(join(dir, `${pid}.${hash(socketPath)}.key`), "utf8"),
    ) as { peerToken?: unknown; procStart?: unknown };
    return typeof key.peerToken === "string" &&
      key.peerToken &&
      key.procStart === procStart
      ? key.peerToken
      : null;
  } catch {
    return null;
  }
}

/**
 * The Claude session this process runs under. Like the daemon's attestation,
 * the nearest ancestor with a session file owns it; an outer one never does.
 */
export function findSession(
  pid: number,
  deps: SessionDeps,
): ClaudeSession | null {
  for (const anc of deps.ancestors(pid)) {
    const file = readSessionFile(deps.sessionsDir, anc);
    if (file.state === "none") continue;
    // The nearest file owns this process, even when it is not a session or not readable yet.
    if (file.state === "unreadable") return null;
    const { rec } = file;
    if (notASession(rec)) return null;
    // No procStart, no way to tell this process from a reused pid.
    if (typeof rec.procStart !== "string") return null;
    const start = deps.procStart(anc);
    if (!start || rec.procStart !== start) return null;
    const socketPath =
      typeof rec.messagingSocketPath === "string"
        ? rec.messagingSocketPath
        : null;
    const peerToken =
      socketPath &&
      peerTokenFor(anc, socketPath, deps.sessionsDir, start, deps.sha256);
    return {
      pid: anc,
      sessionId: rec.sessionId,
      socketPath,
      peerToken,
      name: typeof rec.name === "string" ? rec.name : `claude-${anc}`,
    };
  }
  return null;
}

/**
 * Whether any ancestor has a Claude session file, usable or not: whether a
 * Claude Code session launched this process at all. Another harness that
 * imports Claude's MCP config (Pi, say) runs it with none.
 */
export function hasClaudeAncestor(
  pid: number,
  deps: Pick<SessionDeps, "sessionsDir" | "ancestors">,
): boolean {
  return deps
    .ancestors(pid)
    .some((anc) => readSessionFile(deps.sessionsDir, anc).state !== "none");
}

/** A tool call with no Claude Code session above it: no install would help. */
export const NOT_UNDER_CLAUDE =
  "This MCP server is for Claude Code; use this harness's own bus tools.";

const ps = (field: string, pid: number): string | null => {
  try {
    return (
      execFileSync(systemTool("ps"), ["-o", `${field}=`, "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        // Claude writes procStart as `TZ=UTC LC_ALL=C ps -o lstart=`.
        env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      }).trim() || null
    );
  } catch {
    return null;
  }
};

export function ancestorChain(pid: number): number[] {
  const out: number[] = [];
  let cur = pid;
  for (let i = 0; i < 12 && cur > 1; i += 1) {
    out.push(cur);
    const ppid = Number(ps("ppid", cur));
    if (!ppid || ppid === cur) break;
    cur = ppid;
  }
  return out;
}

export const procStartOf = (pid: number): string | null => ps("lstart", pid);

/**
 * Field 22 of a /proc/<pid>/stat line, `starttime`: clock ticks since boot.
 * comm (field 2) may hold spaces and ')', so fields are counted after the last ')'.
 */
export function statStartTicks(stat: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  // The rest starts at field 3 (state): field 22 is its 20th.
  const start = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)[19];
  return start && /^\d+$/.test(start) ? start : null;
}

export type ClaudeProcStartDeps = {
  platform?: NodeJS.Platform;
  readStat?: (pid: number) => string;
};

/**
 * The start time in the form Claude writes procStart: /proc starttime ticks on
 * Linux, `procStartOf`'s lstart elsewhere. Pi and OpenCode keep `procStartOf`.
 */
export function claudeProcStartOf(
  pid: number,
  deps: ClaudeProcStartDeps = {},
): string | null {
  if ((deps.platform ?? process.platform) !== "linux") return procStartOf(pid);
  try {
    return statStartTicks(
      (deps.readStat ?? ((p) => readFileSync(`/proc/${p}/stat`, "utf8")))(pid),
    );
  } catch {
    return null;
  }
}

/** The MCP server's hello for its session; a name that cannot go on the wire is fitted, never fatal. */
export function sessionHello(
  session: ClaudeSession,
  pid: number,
  cwd: string,
): Hello {
  return Hello.parse({
    v: 1,
    id: "hello",
    type: "hello",
    kind: "claude-code",
    client_version: CLIENT_VERSION,
    agent_ref: session.sessionId,
    pid,
    cwd,
    proposed_name: fitName(session.name, 64) || undefined,
    attest: {
      session_id: session.sessionId,
      socket_path: session.socketPath ?? undefined,
    },
  });
}
