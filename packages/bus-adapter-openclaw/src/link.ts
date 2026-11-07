import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  daemonSocketPath,
  socketDirProblem,
} from "@oa/bus-adapter-claude-code";
import {
  CLIENT_VERSION,
  connectDaemon,
  type DaemonClient,
  type Hello,
} from "@oa/bus-ipc";
import type { Root } from "./roots.ts";

/** What a Link is: the bus-ipc client. Replaced in tests. */
export type Connect = (root: Root) => Promise<DaemonClient>;

/** A hello the daemon refused, or a daemon that is not there. */
export class LinkError extends Error {
  constructor(
    message: string,
    readonly refused = false,
  ) {
    super(message);
    this.name = "LinkError";
  }
}

/** `TZ=UTC LC_ALL=C ps -o lstart=`: the form the daemon re-reads to attest this process. */
export function procStart(pid: number = process.pid): string | undefined {
  try {
    return (
      execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
        timeout: 5000,
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * The real connector: one daemon connection per root, a hello that attests
 * this process by start time (like Pi and Hermes). OA_BUS_HOME moves the
 * socket, as it does for every adapter.
 */
export function realConnect(
  env: Record<string, string | undefined> = process.env,
): Connect {
  const start = procStart();
  return async (root) => {
    const home = resolve(env.OA_BUS_HOME || join(homedir(), ".oa-bus"));
    const problem = socketDirProblem(home);
    if (problem) throw new LinkError(problem);
    const hello: Hello = {
      v: 1,
      id: "hello",
      type: "hello",
      client_version: CLIENT_VERSION,
      kind: "openclaw",
      agent_ref: root.ref,
      pid: process.pid,
      cwd: root.cwd,
      proposed_name: root.proposedName,
      caps: ["mailbox", "pending"],
      attest: start ? { proc_start: start } : {},
    };
    try {
      return await connectDaemon({
        path: daemonSocketPath(home),
        hello,
        onError: () => {},
      });
    } catch (e) {
      const refused = typeof e === "object" && e !== null && "frame" in e;
      throw new LinkError(e instanceof Error ? e.message : String(e), refused);
    }
  };
}
