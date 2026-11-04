import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import {
  messageHeader,
  neutralizeBody,
  oversizedText,
  stripTerminalControls,
  systemTool,
} from "@oa/bus-ipc";
import type { AgentRecord } from "../agents.ts";
import type { DeliverOutcome, Mail } from "../deliver.ts";

/** How long `codex queue` may run; it writes one sqlite row. */
export const CODEX_QUEUE_TIMEOUT_MS = 10_000;
/**
 * The most text one `codex queue` carries, in UTF-8 bytes. Inline bodies are
 * at most 32 KB, so only a bug reaches it; over it, the fetch notice goes.
 */
export const CODEX_TEXT_CAP = 64 * 1024;

/**
 * The wake binary the installer pins: `{"bin": "/abs/path/codex"}` under the
 * Open Artifacts bus home. The CLI writes it (C26e) and the daemon reads it: one key.
 */
export const codexBinFile = (busHome: string): string =>
  join(busHome, "codex.json");

/** The JSON `codexBinFile` holds for `bin`. */
export const codexBinPin = (bin: string): string =>
  `${JSON.stringify({ bin }, null, 2)}\n`;

/** The Codex desktop app, which bundles its own `codex`. */
export const CODEX_APP = "/Applications/ChatGPT.app";
const CODEX_APP_ID = "com.openai.codex";

const executable = (p: string): boolean => {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The `codex` inside the bundle at `app` when the bundle is Codex's (its
 * Info.plist names `com.openai.codex`); never launched. Undefined otherwise.
 */
export function codexAppBin(app: string): string | undefined {
  try {
    // An XML plist; a binary one is not read, so that bundle is not used.
    const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
    const id =
      /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(
        plist,
      )?.[1];
    return id === CODEX_APP_ID
      ? join(app, "Contents", "Resources", "codex")
      : undefined;
  } catch {
    return undefined;
  }
}

/** Where the binary came from: doctor (C26e) names it. */
export type CodexBin = {
  path: string;
  from: "config" | "path" | "app";
};

/**
 * The user's own `codex`, in order: the path the installer pinned (when
 * `configFile` is given), `codex` on `path`, then the desktop app's bundled
 * one (only when the bundle is Codex's; `app: null` looks for none).
 * Undefined when there is none.
 */
export function resolveCodexBin(o: {
  configFile?: string;
  path?: string;
  app?: string | null;
}): CodexBin | undefined {
  if (o.configFile)
    try {
      const raw = JSON.parse(readFileSync(o.configFile, "utf8")) as {
        bin?: unknown;
      };
      if (
        typeof raw.bin === "string" &&
        isAbsolute(raw.bin) &&
        executable(raw.bin)
      )
        return { path: raw.bin, from: "config" };
    } catch {}
  for (const dir of (o.path ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const p = join(dir, "codex");
    if (executable(p)) return { path: p, from: "path" };
  }
  const app = o.app === null ? undefined : codexAppBin(o.app ?? CODEX_APP);
  if (app && executable(app)) return { path: app, from: "app" };
  return undefined;
}

/** `codex` options that take a value: their value is not the subcommand. */
const VALUE_OPTS = new Set([
  "-c",
  "--config",
  "-p",
  "--profile",
  "-m",
  "--model",
  "-C",
  "--cd",
  "-s",
  "--sandbox",
  "-a",
  "--ask-for-approval",
  "-i",
  "--image",
  "--enable",
  "--disable",
  "--remote",
  "--remote-auth-token-env",
  "--local-provider",
  "--add-dir",
]);

/**
 * Whether a process with these arguments (after argv[0]) wakes a thread on
 * `codex queue`: every host but `codex exec`, which is one-shot, so a queued
 * message waits for the next resume (docs/probes/codex.md §3).
 */
export function hostWakes(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") return true;
    if (a.startsWith("-")) {
      if (VALUE_OPTS.has(a)) i++;
      continue;
    }
    return a !== "exec" && a !== "e";
  }
  return true;
}

/**
 * Where argv[0] ends in `ps`'s `args` (argv joined by spaces): after the
 * first `codex` that is the whole string or ends a path segment, and is
 * followed by a space or the end. Among those, a prefix naming an existing
 * file wins, so a space inside the path (`Application Support`) is not a split.
 */
export function splitArgv0(args: string): string[] {
  const words = (s: string) => s.split(/\s+/).filter(Boolean);
  const ends: number[] = [];
  for (const m of args.matchAll(/(?:^|\/)codex(?=\s|$)/g))
    ends.push((m.index ?? 0) + m[0].length);
  if (!ends.length) return words(args).slice(1);
  const real = ends.find((e) => {
    const p = args.slice(0, e);
    try {
      return isAbsolute(p) && statSync(p).isFile();
    } catch {
      return false;
    }
  });
  return words(args.slice(real ?? (ends[0] as number)));
}

const execText = (cmd: string, args: string[]) =>
  new Promise<string | undefined>((resolve) => {
    execFile(
      cmd,
      args,
      {
        encoding: "utf8",
        timeout: 2_000,
        env: { ...process.env, LC_ALL: "C" },
      },
      (err, stdout) => resolve(err ? undefined : stdout),
    );
  });

/**
 * The arguments of process `pid` after argv[0], or undefined when it is gone.
 * Linux reads /proc (exact); elsewhere one `ps -o args=`, split by splitArgv0.
 */
export async function processArgs(pid: number): Promise<string[] | undefined> {
  if (process.platform === "linux") {
    try {
      const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
      return raw.split("\0").slice(1, -1);
    } catch {
      return undefined;
    }
  }
  const out = await execText(systemTool("ps"), [
    "-ww",
    "-o",
    "args=",
    "-p",
    String(pid),
  ]);
  const args = out?.replace(/\n$/, "");
  return args ? splitArgv0(args) : undefined;
}

/**
 * Runs `bin args` with no shell. `code` is null only when killed at its
 * timeout; any other failure (a crash, too much output) is -1. Rejects when
 * it could not start.
 */
export type CodexRun = (
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ code: number | null; stderr: string }>;

const START_ERRORS = new Set(["ENOENT", "EACCES", "ENOEXEC"]);

export const execCodex =
  (timeoutMs = CODEX_QUEUE_TIMEOUT_MS): CodexRun =>
  (bin, args, env) =>
    new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { timeout: timeoutMs, maxBuffer: 64 * 1024, env },
        (err, _stdout, stderr) => {
          if (!err) return resolve({ code: 0, stderr });
          const e = err as NodeJS.ErrnoException & {
            code?: number | string;
            killed?: boolean;
            signal?: NodeJS.Signals | null;
          };
          if (typeof e.code === "string" && START_ERRORS.has(e.code))
            return reject(err);
          resolve({
            // A maxBuffer kill is SIGTERM too, but carries its own string code.
            code:
              e.killed && e.signal === "SIGTERM" && typeof e.code !== "string"
                ? null
                : typeof e.code === "number"
                  ? e.code
                  : -1,
            stderr: String(stderr ?? ""),
          });
        },
      );
    });

/**
 * A message as the Codex thread reads it: the same notice as Pi and omp, with
 * the bus msg_id on the header line so a retry is recognisable.
 */
export function codexText(agent: AgentRecord, mail: Mail): string {
  const header = `${messageHeader({
    from: mail.from_name,
    to: agent.busName,
    namespace: mail.namespace,
    global: agent.global,
  })} (msg_id ${mail.msg_id})`;
  // the bus's own oversized notice is not peer text: it is never escaped.
  const text = mail.notice
    ? `${header}\n\n${mail.body}`
    : `${header}\n\n${neutralizeBody(stripTerminalControls(mail.body))}`;
  if (Buffer.byteLength(text) <= CODEX_TEXT_CAP) return text;
  return `${header}\n\n${oversizedText(mail.notice?.size ?? Buffer.byteLength(mail.body), mail.msg_id)}`;
}

export type CodexTransportOptions = {
  /** Finds the binary; called at start and again after a failure. */
  resolve: () => CodexBin | undefined;
  run: CodexRun;
  /** The CODEX_HOME attestation reads; `codex queue` writes there. */
  home: string;
  /** Whether Codex process `pid` is a host that wakes on a queued message. */
  wakes: (pid: number) => Promise<boolean>;
  /**
   * Ids `codex queue` took (exit 0), or `maybe:<id>` when it was killed at
   * its timeout, kept on disk: never queued twice, across restarts too.
   */
  queued: { has: (id: string) => boolean; add: (id: string) => void };
  log?: (msg: string) => void;
};

type Queue = { ok: true } | { ok: false; taken: "maybe" | "no" | "nobin" };

/**
 * Delivers to a Codex thread with the user's own `codex queue` (D2), and only
 * to a thread loaded in a live host that wakes: it starts a turn with the
 * text, so exit 0 is delivered. A thread under `codex exec` (one-shot, no
 * wake) gets nothing and its mail stays pending, as for an offline agent; a
 * closed thread is refused by createDeliver like any other kind.
 */
export class CodexTransport {
  #bin: CodexBin | undefined;
  #missingLogged = false;
  /** Taken ids the store failed to keep: still never queued twice by this daemon. */
  #taken = new Set<string>();

  constructor(private readonly opts: CodexTransportOptions) {
    this.#bin = opts.resolve();
  }

  /** The binary in use, or undefined when none was found. */
  bin(): CodexBin | undefined {
    return this.#bin;
  }

  async deliver(agent: AgentRecord, mail: Mail): Promise<DeliverOutcome> {
    if (!(await this.#wakes(agent))) return { ok: false, reason: "queued" };
    const r = await this.#queue(agent, mail.msg_id, codexText(agent, mail));
    if (r.ok) return { ok: true };
    return { ok: false, reason: r.taken === "no" ? "timeout" : "queued" };
  }

  /** An Open Artifacts bus notice about mail `msgId` (expired or refused); never a message from a peer. */
  async notify(
    agent: AgentRecord,
    text: string,
    msgId: string,
  ): Promise<boolean> {
    if (!(await this.#wakes(agent))) return false;
    const r = await this.#queue(agent, `notice:${msgId}`, `[oa-bus] ${text}`);
    // Maybe told already: a second copy is worse than none.
    return r.ok || r.taken === "maybe";
  }

  #wakes(agent: AgentRecord): Promise<boolean> {
    return agent.live ? this.opts.wakes(agent.pid) : Promise.resolve(false);
  }

  #has(id: string): boolean {
    return this.#taken.has(id) || this.opts.queued.has(id);
  }

  /** Remembers a taken id; a failing store is loud, and memory still holds it. */
  #keep(id: string): boolean {
    this.#taken.add(id);
    try {
      this.opts.queued.add(id);
      this.#taken.delete(id);
      return true;
    } catch (e) {
      this.opts.log?.(
        `ERROR: codex took ${id} but it could not be recorded (${e instanceof Error ? e.message : String(e)}); a daemon restart could queue it again`,
      );
      return false;
    }
  }

  async #queue(agent: AgentRecord, id: string, text: string): Promise<Queue> {
    if (this.#has(id)) return { ok: true };
    // Maybe never landed: stays queued, so it ends expired, never a false Delivered.
    if (this.#has(`maybe:${id}`)) return { ok: false, taken: "maybe" };
    this.#bin ??= this.opts.resolve();
    const bin = this.#bin;
    if (!bin) {
      // Stays pending at the hub, as for an offline agent; doctor says why.
      if (!this.#missingLogged)
        this.opts.log?.(
          "no codex binary found (config, PATH or the Codex app); Codex messages stay queued",
        );
      this.#missingLogged = true;
      return { ok: false, taken: "nobin" };
    }
    this.#missingLogged = false;
    // `=` keeps a value that starts with `-` from reading as an option.
    const args = ["queue", `--thread=${agent.ref}`, `--message=${text}`];
    let res: Awaited<ReturnType<CodexRun>>;
    try {
      res = await this.opts.run(bin.path, args, {
        ...process.env,
        CODEX_HOME: this.opts.home,
      });
    } catch (e) {
      this.#bin = undefined;
      this.opts.log?.(
        `codex queue could not start (${bin.path}): ${e instanceof Error ? e.message : String(e)}`,
      );
      return { ok: false, taken: "no" };
    }
    if (res.code === 0) {
      return this.#keep(id) ? { ok: true } : { ok: false, taken: "maybe" };
    }
    if (res.code === null) {
      // Killed at its timeout: it may have written the row, and a second copy is worse than a late one.
      this.#keep(`maybe:${id}`);
      this.opts.log?.(
        `codex queue for ${agent.ref} timed out; not queued again`,
      );
      return { ok: false, taken: "maybe" };
    }
    this.#bin = undefined;
    this.opts.log?.(
      `codex queue for ${agent.ref} exited ${res.code}: ${stripTerminalControls(res.stderr.trim()).slice(0, 300)}`,
    );
    return { ok: false, taken: "no" };
  }
}

/** The default `wakes`: the process is there and is not `codex exec`. */
export const codexHostWakes = async (pid: number): Promise<boolean> => {
  const args = await processArgs(pid);
  return args !== undefined && hostWakes(args);
};
