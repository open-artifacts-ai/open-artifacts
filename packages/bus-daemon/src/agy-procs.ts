import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { busHome } from "@oa/bus-adapter-claude-code";
import { systemTool } from "@oa/bus-ipc";

/**
 * agy S2b: the reads the daemon makes to list an agy (Antigravity CLI)
 * process before its first message. agy runs no hook and no MCP server until
 * then, so the process table is the only sign it is there.
 */

/**
 * The pids running the agy binary, from one `ps` over every process; null
 * when ps cannot be read (unknown, never "none run"). The binary is matched
 * by name, as S1a's attest does (`commOf`). Asynchronous, so a slow ps never
 * holds up hub frames or socket hellos.
 */
export function agyPids(): Promise<number[] | null> {
  return new Promise((resolve) => {
    execFile(
      systemTool("ps"),
      ["-axo", "pid=,comm="],
      { encoding: "utf8", timeout: 1500, maxBuffer: 8 * 1024 * 1024 },
      (err, out) => resolve(err ? null : parseAgyPids(out)),
    );
  });
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

/** The global agy plugin's hooks file that `oa-bus install` writes. */
export const agyHooksFile = (userHome: string = homedir()): string =>
  join(userHome, ".gemini", "config", "plugins", "oa-bus", "hooks.json");

/**
 * Where the installed agy plugin's hook sends a session: the bus `home`, and
 * whether the hook pins it (`export OA_BUS_HOME=...`, written for a moved
 * home) or follows the agy process's own OA_BUS_HOME (unset: the default
 * home). A pinned hook ignores the process's environment.
 */
export type AgyPluginRoute = { home: string; pinned: boolean };

/**
 * The route the agy plugin's hooks.json names (as `agyHookCommand` writes
 * it), null when there is no oa-bus hook there: no conversation would ever
 * join, so no daemon lists agy. The plugin is global, so exactly one bus home
 * on the machine owns agy discovery: the one this names.
 */
export function agyPluginHome(
  file: string = agyHooksFile(),
): AgyPluginRoute | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return parseAgyPluginHome(text);
}

/** hooks.json text to the route its oa-bus hook names (agyPluginHome). */
export function parseAgyPluginHome(text: string): AgyPluginRoute | null {
  let hooks: unknown;
  try {
    hooks = JSON.parse(text);
  } catch {
    return null;
  }
  const ours = (hooks as Record<string, unknown> | null)?.["oa-bus"] as
    | Record<string, unknown>
    | undefined;
  const handlers = ours?.SessionStart;
  if (!Array.isArray(handlers)) return null;
  const command = handlers
    .map((h) => (h as { command?: unknown } | null)?.command)
    .find((c): c is string => typeof c === "string" && c.includes("agy-hello"));
  if (command === undefined) return null;
  const m = /^export OA_BUS_HOME='((?:[^']|'\\'')*)'; /.exec(command);
  if (!m) return { home: busHome({}), pinned: false };
  return {
    home: busHome({ OA_BUS_HOME: (m[1] as string).replaceAll("'\\''", "'") }),
    pinned: true,
  };
}
