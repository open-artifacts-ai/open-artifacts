import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import {
  busHome,
  claudeReturnDir,
  daemonSocketPath,
  NOT_OURS,
  shortDirInUse,
  shortSocketDir,
  socketDirProblem,
  unsafeSocketDir,
} from "@oa/bus-adapter-claude-code";
import { CODEX_APP } from "@oa/bus-daemon";
import {
  DaemonSilentError,
  daemonStatus,
  type StatusReply,
  systemTool,
} from "@oa/bus-ipc";
import { type Copy, copy } from "./copy.ts";
import { type Deps, realDeps } from "./deps.ts";
import { cliSource, systemService } from "./steps/service.ts";
import { detectStyle, type Env, type Stream, type Style } from "./term.ts";

/** What doctor reports about an installed service that still runs. */
export type ServiceProblem =
  | { kind: "node-missing"; node: string }
  | { kind: "linger-off" };

/**
 * The OS service that keeps the daemon running: launchd or systemd --user
 * (steps/service.ts). Without one, `oa-bus daemon` runs in a terminal.
 */
export type Service = {
  /** The installed service; undefined when none is. */
  kind?: "launchd" | "systemd";
  /**
   * Installs and (re)starts it, or starts the daemon in the background.
   * `running`: a daemon that would not stop holds the socket, and nothing
   * was started.
   */
  ensure: () => Promise<{ running?: number }>;
  /** install could not start a service and runs the daemon itself. */
  fallback?: boolean;
  /**
   * Stops and removes the service (`unit`), or stops a daemon running
   * without one (`stopped`). `running`: a daemon still answers after.
   */
  remove: () => Promise<{
    unit?: "launchd" | "systemd";
    stopped?: boolean;
    running?: number;
  }>;
  problems?: () => ServiceProblem[];
  /** The installed service's environment, as install recorded it; empty when none is. */
  env?: () => Record<string, string>;
  /**
   * Copies the CLI to <OA_BUS_HOME>/bin; the argv that runs that copy, for
   * the service and every harness entry. Never argv[1]: under npx it is a
   * cache path that gets cleaned.
   */
  cli: () => string[];
  /**
   * Runs the node install would pin and returns why it is unusable (missing
   * ICU, gone, crashes); undefined when it works. Absent: nothing to pin.
   */
  checkNode?: () => Promise<{ node: string; reason: string } | undefined>;
  /** The argv `cli()` returns, without copying anything: for read-only checks. */
  argv?: () => string[];
};
export const noService: Service = {
  ensure: async () => ({}),
  remove: async () => ({}),
  cli: () => ["oa-bus"],
};

export type Out = Stream & { write: (s: string) => unknown };

/** Everything a command touches outside its own logic. */
export type Ctx = Deps & {
  stdout: Out;
  stderr: Out;
  env: Env;
  cwd: string;
  /** The user's home: harness configs live under it. */
  userHome: string;
  /** OA_BUS_HOME. */
  home: string;
  which: (cmd: string) => boolean;
  service: Service;
  status: (opts: {
    path: string;
    cwd?: string;
    timeoutMs?: number;
  }) => Promise<StatusReply>;
  version: string;
  style: Style;
  copy: Copy;
  platform: string;
  nodeVersion: string;
  /** The Codex desktop app's bundle (macOS); undefined: none to look for. */
  codexApp?: string;
};

/** The package's version, set by the bundler (scripts/bundle.mjs). */
declare const __OA_BUS_VERSION__: string | undefined;

export const VERSION: string =
  typeof __OA_BUS_VERSION__ === "string"
    ? __OA_BUS_VERSION__
    : (
        JSON.parse(
          readFileSync(new URL("../package.json", import.meta.url), "utf8"),
        ) as { version: string }
      ).version;

const which = (cmd: string) => {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/**
 * A process's command line: `ps`, else /proc (slim containers lack ps). It
 * decides whether stopDaemon signals a pid, so ps comes from the system dirs.
 */
export function processArgs(
  pid: number,
  io = {
    ps: (pid: number) =>
      execFileSync(systemTool("ps"), ["-o", "args=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    proc: (path: string) => readFileSync(path, "utf8"),
  },
): string | undefined {
  try {
    return io.ps(pid).trim() || undefined;
  } catch {}
  try {
    return (
      io.proc(`/proc/${pid}/cmdline`).split("\0").filter(Boolean).join(" ") ||
      undefined
    );
  } catch {
    return undefined;
  }
}

/** The daemon detached from this process, its output appended to the logs. */
const spawnDaemon = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string>; out: string; err: string },
) => {
  const out = openSync(opts.out, "a", 0o600);
  const err = openSync(opts.err, "a", 0o600);
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: ["ignore", out, err],
      env: { ...process.env, ...opts.env },
    });
    child.unref();
    return child.pid;
  } finally {
    closeSync(out);
    closeSync(err);
  }
};

const userName = () => {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
};

export function realCtx(noColor: boolean): Ctx {
  const env = process.env;
  const style = detectStyle(env, process.stdout, noColor);
  const ctx: Ctx = {
    ...realDeps,
    print: (line) => process.stdout.write(`${line}\n`),
    stdout: process.stdout,
    stderr: process.stderr,
    env,
    cwd: process.cwd(),
    userHome: homedir(),
    // Absolute: the plist and unit must never carry a relative path.
    home: busHome(env),
    which,
    service: noService,
    status: daemonStatus,
    version: VERSION,
    style,
    copy: copy(style),
    platform: `${process.platform} ${process.arch}`,
    nodeVersion: process.version,
    ...(process.platform === "darwin" ? { codexApp: CODEX_APP } : {}),
  };
  ctx.service = systemService({
    platform: process.platform,
    userHome: ctx.userHome,
    home: () => ctx.home,
    env,
    exec: ctx.exec,
    sleep: ctx.sleep,
    execPath: process.execPath,
    uid: process.getuid?.() ?? 0,
    user: userName(),
    source: cliSource,
    daemonPid: () =>
      askDaemon(ctx, { timeoutMs: 1000 }).then(
        (st) => st.pid,
        () => undefined,
      ),
    processArgs,
    kill: (pid) => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    },
    spawnDaemon,
  });
  return ctx;
}

/**
 * Asks the daemon for its status. A socket in a short folder another user
 * made or can reach is never dialed: whatever answers there is not the daemon.
 */
export function askDaemon(
  ctx: Pick<Ctx, "home" | "status">,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<StatusReply> {
  const problem = socketDirProblem(ctx.home);
  if (problem) return Promise.reject(new Error(problem));
  return ctx.status({ ...opts, path: daemonSocketPath(ctx.home) });
}

/** The pause before the one retry of a probe that got no answer, and that retry's timeout. */
const PROBE_RETRY_MS = 500;
const PROBE_RETRY_TIMEOUT_MS = 1500;

/**
 * Probes the daemon for status and says which of three things it saw: up
 * (a reply, even with the hub link down), down (no socket, refused, or any
 * other failure to connect), or stalled (the socket took the connection but
 * gave no usable reply, twice: a transient stall, such as a hub reconnect,
 * reads as up on the retry).
 *
 * A socket that accepts the connection is the evidence the daemon runs: a
 * stale socket file with no listener gives ECONNREFUSED, which is down. No
 * service query is needed. The worst case is about 5 s (3 s, a pause, 1.5 s).
 */
export async function probeDaemon(
  ctx: Pick<Ctx, "home" | "status" | "sleep">,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<
  { state: "up"; st: StatusReply } | { state: "down" } | { state: "stalled" }
> {
  for (let attempt = 0; ; attempt++) {
    try {
      return {
        state: "up",
        st: await askDaemon(
          ctx,
          attempt > 0 ? { ...opts, timeoutMs: PROBE_RETRY_TIMEOUT_MS } : opts,
        ),
      };
    } catch (e) {
      if (!(e instanceof DaemonSilentError)) return { state: "down" };
      if (attempt > 0) return { state: "stalled" };
      await ctx.sleep(PROBE_RETRY_MS);
    }
  }
}

/** Why the daemon cannot run: an unsafe short socket folder it needs, or undefined. */
export function socketFolderLines(
  ctx: Pick<Ctx, "home" | "userHome" | "copy">,
): string[] | undefined {
  // The daemon refuses an unsafe short folder whichever socket needs it.
  const dirs = shortDirInUse(ctx.home)
    ? [shortSocketDir(ctx.home), claudeReturnDir(ctx.home)]
    : [];
  const bad = dirs
    .map((d) => ({ d, why: unsafeSocketDir(d) }))
    .find((x) => x.why);
  if (!bad) return undefined;
  return bad.why === NOT_OURS
    ? ctx.copy.socketFolderNotYours(bad.d)
    : ctx.copy.socketFolderUnsafe(tilde(ctx, bad.d), bad.why as string);
}

/** Writes lines to stdout, or to stderr for a failure block. */
export const say = (ctx: Ctx, ...lines: (string | string[])[]) => {
  for (const l of lines.flat()) ctx.stdout.write(`${l}\n`);
};
export const sayErr = (ctx: Ctx, ...lines: (string | string[])[]) => {
  for (const l of lines.flat()) ctx.stderr.write(`${l}\n`);
};

/** A Codex reason starts with its config's path: shown under `~` (C26e). */
export const tildeReason = (
  ctx: Pick<Ctx, "userHome">,
  harness: string,
  reason: string,
) =>
  harness === "codex" && reason.startsWith(`${ctx.userHome}/`)
    ? `~${reason.slice(ctx.userHome.length)}`
    : reason;

/** `~/.oa-bus/machine.json` for paths under the user's home. */
export const tilde = (ctx: Pick<Ctx, "userHome">, path: string) =>
  path === ctx.userHome
    ? "~"
    : path.startsWith(`${ctx.userHome}/`)
      ? `~${path.slice(ctx.userHome.length)}`
      : path;
