import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { daemonSocketPath } from "@oa/bus-adapter-claude-code";
import { createEventLog } from "@oa/bus-daemon";
import { daemonLinkProof, systemTool } from "@oa/bus-ipc";
import { LINK_PROOF_HEADER } from "@oa/bus-protocol";
import { type Ctx, say } from "../context.ts";
import { UNBOUND_EVENT } from "../steps/claude-sessions.ts";

/** The most the helper waits for its log line. */
const LOG_WAIT_MS = 300;

/** What the helper reads from the process table and the daemon; tests bring their own. */
export type ProofDeps = {
  /** A process's parent and executable name; null when it cannot be read. */
  proc: (pid: number) => { ppid: number; name: string } | null;
  /** Tells the daemon; true when a live Claude record took the hash. */
  link: (pid: number, hash: string) => Promise<boolean>;
  /** 32 random bytes. */
  random: () => Buffer;
  /** The helper's own parent: the shell, or Claude itself. */
  ppid: number;
};

/** Claude's process: its name is `claude` (the native build's file is named by version). */
const isClaude = (name: string) =>
  name === "claude" || /\/claude\/versions\/[^/]+$/.test(name);

/** One `ps -o ppid=,comm=` line. The full path is kept when it is Claude's versions file. */
export function parsePs(out: string): { ppid: number; name: string } | null {
  const m = /^(\d+)\s+(.+)$/.exec(out.trim());
  if (!m) return null;
  const comm = m[2] as string;
  return { ppid: Number(m[1]), name: isClaude(comm) ? comm : basename(comm) };
}

/** `/proc` on Linux; `ps` elsewhere. */
function readProc(pid: number): { ppid: number; name: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 1).split(/\s+/)[2]);
    let exe = "";
    try {
      exe = readlinkSync(`/proc/${pid}/exe`);
    } catch {}
    const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    return { ppid, name: isClaude(exe) ? exe : comm };
  } catch {}
  try {
    const out = execFileSync(
      systemTool("ps"),
      ["-o", "ppid=,comm=", "-p", String(pid)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return parsePs(out);
  } catch {
    return null;
  }
}

/** The first process above `from` (itself included) whose executable is Claude. */
export function findClaude(
  from: number,
  proc: ProofDeps["proc"],
): number | undefined {
  let pid = from;
  for (let i = 0; i < 12 && pid > 1; i += 1) {
    const p = proc(pid);
    if (!p) return undefined;
    if (isClaude(p.name)) return pid;
    pid = p.ppid;
  }
  return undefined;
}

/** The token, trimmed; undefined when the file cannot be read or is empty. */
function tokenOf(file: string | undefined): string | undefined {
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `headersHelper` of the instance's Claude entry (#1822). Claude runs it
 * at each connection and on a 401, and sends the JSON it prints as headers.
 * It makes a new proof, tells the daemon which Claude process it belongs to,
 * and prints the proof header. With `--token-file` it also prints what the
 * entry's old helper printed, the Authorization line. It never prints
 * Authorization for an OAuth entry: Claude would stop using its own sign-in.
 * Any problem prints only what the entry printed before and exits 0 (Claude
 * must still connect), and adds one line with the cause to the bus event log
 * (#2688), so doctor can say why a session is unlinked. No secret goes in it.
 */
export async function mcpProof(
  opts: { tokenFile?: string },
  ctx: Ctx,
  deps: ProofDeps = {
    proc: readProc,
    link: (pid, hash) =>
      daemonLinkProof({ path: daemonSocketPath(ctx.home), pid, hash }),
    random: () => randomBytes(32),
    ppid: process.ppid,
  },
): Promise<number> {
  const headers: Record<string, string> = {};
  const token = tokenOf(opts.tokenFile);
  if (token) headers.Authorization = `Bearer ${token}`;
  let why: string | undefined;
  let detail: string | undefined;
  let claude: number | undefined;
  try {
    claude = findClaude(deps.ppid, deps.proc);
    if (claude === undefined) why = "no_claude_ancestor";
  } catch {
    why = "process_table_error";
  }
  if (claude !== undefined)
    try {
      const proof = deps.random().toString("base64url");
      const hash = createHash("sha256").update(proof).digest("hex");
      // The daemon answers false only for a pid it could not match to a live
      // record by start time (it holds a proof that has no record yet).
      if (await deps.link(claude, hash)) headers[LINK_PROOF_HEADER] = proof;
      else why = "process_not_matched";
    } catch (e) {
      why = "daemon_unreachable";
      // The class only (never a message or a path): why the daemon was not reached.
      const code = (e as { code?: unknown })?.code;
      const msg = e instanceof Error ? e.message : "";
      detail =
        code === "ENOENT" || code === "ECONNREFUSED"
          ? code
          : /did not answer|time/i.test(msg)
            ? "timeout"
            : "other";
    }
  // Claude's connect comes first: the headers go out before the log is touched.
  say(ctx, JSON.stringify(headers));
  if (why !== undefined)
    try {
      const events = createEventLog(join(ctx.home, "logs", "events.log"));
      events(UNBOUND_EVENT, {
        reason: why,
        ...(detail !== undefined ? { code: detail } : {}),
      });
      // Bounded: a slow disk never holds the helper up.
      await Promise.race([
        events.flush(),
        new Promise((r) => setTimeout(r, LOG_WAIT_MS).unref()),
      ]);
    } catch {}
  return 0;
}
