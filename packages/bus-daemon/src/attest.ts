import { execFileSync } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import {
  ancestorChain,
  claudeProcStartOf,
  claudeSessionsDir,
  notASession,
  procStartOf,
  readSessionFile,
} from "@oa/bus-adapter-claude-code";
import { type Hello, systemTool } from "@oa/bus-ipc";
import { type CodexAttestor, codexAttestor } from "./codex-attest.ts";
import { isRunning } from "./liveness/claude.ts";
import {
  lstartEpoch,
  opencodePresenceDir,
  openSessions,
} from "./presence/opencode.ts";

export { ancestorChain, claudeProcStartOf, procStartOf };

export type AttestDeps = {
  sessionsDir?: string;
  ancestors?: (pid: number) => number[];
  /**
   * Overrides both checks, which use different formats on Linux: Claude's
   * /proc start ticks (default claudeProcStartOf) and Pi's lstart (procStartOf).
   */
  procStart?: (pid: number) => string | null;
  openSessions?: () => Set<string>;
  /** The executable a pid runs (`ps -o comm=`), null when it cannot be told. */
  comm?: (pid: number) => string | null;
  /** The daemon's codex attestor: it pins state across hellos, so one per daemon. */
  codex?: CodexAttestor;
};

/**
 * `cwd` is the session's own working directory, when the harness records one;
 * `pid` is the session's process when it is not the adapter (Claude's MCP server).
 */
export type Attest =
  | { ok: true; cwd?: string; pid?: number }
  | { ok: false; reason: string };

let defaultCodex: CodexAttestor | undefined;

/** Verifies the adapter's claimed identity locally; the hello alone is never trusted. */
export function attest(hello: Hello, deps: AttestDeps = {}): Attest {
  switch (hello.kind) {
    case "claude-code":
      return attestClaude(hello, deps);
    case "opencode":
      return attestOpenCode(hello, deps);
    // omp runs under bun, so comm is never read: the start time is the check.
    case "pi":
    case "omp": {
      const kind = hello.kind;
      if (!hello.attest.proc_start) {
        return { ok: false, reason: `${kind} hello has no proc_start` };
      }
      const start = (deps.procStart ?? procStartOf)(hello.pid);
      if (!start)
        return { ok: false, reason: `${kind} process is not running` };
      if (hello.attest.proc_start !== start) {
        return { ok: false, reason: `${kind} process start time moved` };
      }
      return { ok: true };
    }
    case "codex":
      // Without the daemon's one wait for a late call line: runDaemon awaits `attest` itself.
      if (deps.codex) return deps.codex.attestNow(hello);
      defaultCodex ??= codexAttestor();
      return defaultCodex.attestNow(hello);
  }
}

function attestClaude(hello: Hello, deps: AttestDeps): Attest {
  const dir = deps.sessionsDir ?? claudeSessionsDir();
  for (const pid of (deps.ancestors ?? ancestorChain)(hello.pid)) {
    const file = readSessionFile(dir, pid);
    if (file.state === "none") continue;
    // The nearest session owns this process; an outer (ancestor) session is never claimable.
    if (file.state === "unreadable")
      return { ok: false, reason: "session file unreadable; retry" };
    const raw = file.rec;
    // Liveness never counts a parked job or an agent-bus peer: attesting one would flap.
    if (raw.sessionId !== hello.agent_ref || notASession(raw)) {
      return {
        ok: false,
        reason: "agent_ref does not match a live Claude session",
      };
    }
    // Without procStart a reused pid is indistinguishable from the session.
    if (typeof raw.procStart !== "string") {
      return { ok: false, reason: "Claude session has no procStart" };
    }
    const start = (deps.procStart ?? claudeProcStartOf)(pid);
    if (!start) return { ok: false, reason: "session process is not running" };
    if (raw.procStart !== start) {
      return { ok: false, reason: "session process start time moved" };
    }
    if (typeof raw.cwd !== "string" || !isAbsolute(raw.cwd)) {
      return { ok: false, reason: "Claude session has no absolute cwd" };
    }
    return { ok: true, cwd: raw.cwd, pid };
  }
  return { ok: false, reason: "no Claude session in the ancestry" };
}

/**
 * The adapter must run under an OpenCode service, and the session a TUI lists.
 * `session_id` is the calling session; the adapter mapped it to `agent_ref`,
 * its root, and the daemon does not re-ask OpenCode (it would block every hello).
 * The service's pid is the identity: its MCP child may restart under it.
 */
function attestOpenCode(hello: Hello, deps: AttestDeps): Attest {
  if (!hello.attest.session_id)
    return { ok: false, reason: "opencode hello has no session_id" };
  const comm = deps.comm ?? commOf;
  const service = (deps.ancestors ?? ancestorChain)(hello.pid).find(
    (pid) => basename(comm(pid) ?? "") === "opencode",
  );
  if (service === undefined)
    return { ok: false, reason: "not running under an OpenCode service" };
  if (!(deps.openSessions ?? defaultOpenSessions)().has(hello.agent_ref))
    return { ok: false, reason: "opencode session is not open in a TUI" };
  return { ok: true, pid: service };
}

export function commOf(pid: number): string | null {
  try {
    return (
      execFileSync(systemTool("ps"), ["-o", "comm=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function defaultOpenSessions(): Set<string> {
  return openSessions(opencodePresenceDir(), {
    isRunning,
    procStartEpoch: (pid) => lstartEpoch(procStartOf(pid)),
  });
}
