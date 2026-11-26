import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readlinkSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { systemTool } from "@oa/bus-ipc";

/**
 * agy S2b: the reads the daemon makes to list an agy (Antigravity CLI)
 * process before its first message. agy runs no hook and no MCP server until
 * then, so the process table is the only sign it is there.
 */

/**
 * The pids running the agy binary, from one `ps` over every process; null
 * when ps cannot be read (unknown, never "none run"). The binary is matched
 * by name, as S1a's attest does (`commOf`).
 */
export function agyPids(): number[] | null {
  let out: string;
  try {
    out = execFileSync(systemTool("ps"), ["-axo", "pid=,comm="], {
      encoding: "utf8",
      timeout: 1500,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  return parseAgyPids(out);
}

/** `ps -o pid=,comm=` lines to the pids whose binary is `agy`. */
export function parseAgyPids(out: string): number[] {
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    if (basename(m[2] as string) !== "agy") continue;
    const pid = Number(m[1]);
    if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/**
 * The working directory of `pid`, or null when it cannot be read: /proc on
 * Linux, `lsof -d cwd` elsewhere (macOS). Only the user's own processes are
 * readable, which is every agy the user runs.
 */
export function cwdOfPid(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const p = readlinkSync(`/proc/${pid}/cwd`);
      return isAbsolute(p) ? p : null;
    } catch {
      return null;
    }
  }
  let out: string;
  try {
    out = execFileSync(
      systemTool("lsof"),
      ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
      {
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return null;
  }
  return parseLsofCwd(out);
}

/** The `n` field of `lsof -Fn` output: the path, when absolute. */
export function parseLsofCwd(out: string): string | null {
  for (const line of out.split("\n"))
    if (line.startsWith("n") && isAbsolute(line.slice(1))) return line.slice(1);
  return null;
}

/**
 * The ref an agy process is listed under while it has no conversation:
 * derived from its pid and start time, so a restarted daemon lists the same
 * process under the same ref (the hub reopens the same row, its held mail
 * kept) and a reused pid is a new ref. Never a conversation id (those are
 * UUIDs).
 */
export const agyStartingRef = (pid: number, procStart: string): string =>
  `agy-starting-${pid}-${createHash("sha256").update(procStart).digest("hex").slice(0, 12)}`;
