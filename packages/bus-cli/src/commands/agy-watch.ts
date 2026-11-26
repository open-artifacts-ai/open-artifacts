import { execFile } from "node:child_process";
import {
  type AgyConversation,
  AgySentIds,
  agyHello,
  clearAgyWatch,
  daemonSocketPath,
  findAgy,
  isAgy,
  type Proc,
  procStartOf,
  readAgyConversation,
  readAgyWatch,
  readProc,
  socketDirProblem,
  writeAgyWatch,
} from "@oa/bus-adapter-claude-code";
import {
  ADAPTER_CAPS,
  AGY_WATCHER_RUNNING,
  CLIENT_VERSION,
  connectDaemon,
  type DaemonClient,
  type DaemonFrame,
  type Hello,
  HelloRefused,
} from "@oa/bus-ipc";
import { type Ctx, say } from "../context.ts";

/** How long `agentapi send-message` may take; agy answers in ~0.2 s. */
const SEND_TIMEOUT_MS = 20_000;
/** How often the watcher checks that its agy process still runs. */
const AGY_CHECK_MS = 5_000;
/** Waits between tries to reach the daemon, capped at the last. */
const BACKOFF_MS = [500, 1000, 2000, 5000, 10_000, 30_000];
/** The title agy shows on a message the watcher hands it: ours, never a peer's. */
export const AGY_MESSAGE_TITLE = "Open Artifacts bus";

type AgyDeliver = Extract<DaemonFrame, { type: "agy_deliver" }>;

/** `ok: false` with `unknown` when the call may have reached agy (a timeout). */
export type SendResult =
  | { ok: true }
  | { ok: false; unknown?: true; detail: string };

export type AgyWatchDeps = {
  proc: Proc;
  procStart: (pid: number) => string | null;
  /** The watcher's parent: the shell agy ran it in, or agy itself. */
  ppid: number;
  pid: number;
  env: Record<string, string | undefined>;
  /** `agy agentapi send-message <conversation> <text>`, with agy's own env. */
  send: (
    agyBin: string,
    conversation: string,
    text: string,
  ) => Promise<SendResult>;
  /** The watcher's own link to the daemon. */
  connect: (hello: Hello) => Promise<DaemonClient>;
  /** The hook's hello for a conversation: joins it again after a daemon restart. */
  rejoin: (hello: Hello) => Promise<void>;
  /** Resolves after `ms`, or at once when `abort` fires. */
  sleep: (ms: number, abort: AbortSignal) => Promise<void>;
  /** Calls `fn` every `ms` until the returned stop is called. */
  every: (ms: number, fn: () => void) => () => void;
  log: (line: string) => void;
  /** Runs `fn` when the process is told to stop (agy ends its background task). */
  onStop: (fn: () => void) => void;
};

/** Exit and timeout: a killed call may have been taken, so it is never sent again. */
const execSend =
  (env: Record<string, string | undefined>): AgyWatchDeps["send"] =>
  (bin, conversation, text) =>
    new Promise((resolve) => {
      execFile(
        bin,
        [
          "agentapi",
          "send-message",
          `--title=${AGY_MESSAGE_TITLE}`,
          conversation,
          text,
        ],
        // agy's own env: its agentapi address and token, never printed.
        { env, timeout: SEND_TIMEOUT_MS, maxBuffer: 256 * 1024 },
        (err, _stdout, stderr) => {
          if (!err) return resolve({ ok: true });
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          resolve({
            ok: false,
            ...(e.killed ? { unknown: true as const } : {}),
            detail: String(stderr || e.message)
              .split("\n")[0]
              ?.slice(0, 200) as string,
          });
        },
      );
    });

const defaults = (ctx: Ctx): AgyWatchDeps => ({
  proc: readProc,
  procStart: procStartOf,
  ppid: process.ppid,
  pid: process.pid,
  env: process.env,
  send: execSend(process.env),
  connect: async (hello) => {
    const problem = socketDirProblem(ctx.home);
    if (problem) throw new Error(problem);
    return connectDaemon({ path: daemonSocketPath(ctx.home), hello });
  },
  rejoin: async (hello) => {
    const c = await connectDaemon({
      path: daemonSocketPath(ctx.home),
      hello,
      timeoutMs: 3000,
    });
    c.close();
  },
  sleep: (ms, abort) =>
    new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        abort.removeEventListener("abort", done);
        resolve();
      }
      abort.addEventListener("abort", done);
    }),
  every: (ms, fn) => {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  },
  log: (line) => say(ctx, line),
  onStop: (fn) => {
    for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const)
      process.once(sig, () => {
        fn();
        process.exit(0);
      });
  },
});

/** The watcher's hello: its own pid, its agy process's start time, the agy_watch cap. */
export function agyWatchHello(
  conv: AgyConversation,
  pid: number,
): Hello | undefined {
  const base = agyHello(conv, [ADAPTER_CAPS.agyWatch]);
  return base
    ? { ...base, client_version: CLIENT_VERSION, pid, id: "watch" }
    : undefined;
}

/**
 * agy S3: `oa-bus agy-watch`, started once per agy process by its session as
 * a background command outside agy's sandbox (the only place agy gives a
 * process its agentapi address and token). It finds that agy process among
 * its parents, proves itself to the daemon by it, and hands each bus message
 * for that process's conversation to `agy agentapi send-message`: a running
 * turn gets it at its next tool step, an idle session wakes. It never hands
 * one msg_id to agy twice, also across restarts, and it exits when its agy
 * process does. A second start for the same agy process exits at once.
 */
export async function agyWatch(
  ctx: Ctx,
  over: Partial<AgyWatchDeps> = {},
): Promise<number> {
  const deps = { ...defaults(ctx), ...over };
  const agy = findAgy(deps.ppid, deps.proc);
  const agyStart = agy === undefined ? null : deps.procStart(agy);
  if (agy === undefined || agyStart === null) {
    deps.log(
      "oa-bus agy-watch: not started by an Antigravity session; it runs only from one.",
    );
    return 1;
  }
  // Names only: the values are agy's and never leave this process.
  if (!deps.env.ANTIGRAVITY_LS_ADDRESS || !deps.env.ANTIGRAVITY_CSRF_TOKEN) {
    deps.log(
      "oa-bus agy-watch: Antigravity gave this command no way to reach the session. Run it as a background command with BypassSandbox: true.",
    );
    return 1;
  }
  const selfStart = deps.procStart(deps.pid);
  const prior = readAgyWatch(ctx.home, agy);
  if (
    prior &&
    prior.pid !== deps.pid &&
    prior.agyStart === agyStart &&
    deps.procStart(prior.pid) === prior.procStart
  ) {
    deps.log("oa-bus agy-watch: already running for this session.");
    return 0;
  }
  if (selfStart !== null)
    writeAgyWatch(ctx.home, agy, {
      pid: deps.pid,
      procStart: selfStart,
      agyStart,
    });
  const agyBin = agyBinary(agy, deps);
  const sent = new AgySentIds(ctx.home, agy, agyStart);
  const gone = new AbortController();
  const stopCheck = deps.every(AGY_CHECK_MS, () => {
    if (deps.procStart(agy) !== agyStart) gone.abort();
  });
  const cleanup = () => {
    stopCheck();
    clearAgyWatch(ctx.home, agy, deps.pid);
  };
  deps.onStop(cleanup);
  /** Ids being handed to agy now: a push again while one runs waits for it. */
  const handing = new Set<string>();
  let client: DaemonClient | undefined;

  const hand = async (f: AgyDeliver, via: DaemonClient) => {
    if (sent.has(f.msg_id)) return via.ack(f.msg_id);
    if (handing.has(f.msg_id)) return;
    // Only the conversation the hook recorded for this agy process, ever.
    const conv = readAgyConversation(ctx.home, agy);
    if (
      !conv ||
      conv.procStart !== agyStart ||
      conv.conversationId !== f.conversation_id
    ) {
      deps.log(
        `oa-bus agy-watch: ${f.msg_id} is for another conversation; not handed on`,
      );
      return via.agyFailed(f.msg_id);
    }
    handing.add(f.msg_id);
    // Written first: a watcher that dies mid-call never sends it again.
    sent.add(f.msg_id);
    const r = await deps.send(agyBin, f.conversation_id, f.text);
    handing.delete(f.msg_id);
    const to = client ?? via;
    if (r.ok || r.unknown) {
      deps.log(
        r.ok
          ? `oa-bus agy-watch: delivered ${f.msg_id}`
          : `oa-bus agy-watch: ${f.msg_id} may have been delivered (${r.detail}); not sent again`,
      );
      return to.ack(f.msg_id);
    }
    sent.delete(f.msg_id);
    deps.log(`oa-bus agy-watch: agy did not take ${f.msg_id}: ${r.detail}`);
    to.agyFailed(f.msg_id);
  };

  let tries = 0;
  deps.log(`oa-bus agy-watch: watching for bus messages for agy ${agy}.`);
  while (!gone.signal.aborted) {
    const conv = readAgyConversation(ctx.home, agy);
    const hello =
      conv && conv.procStart === agyStart
        ? agyWatchHello(conv, deps.pid)
        : undefined;
    if (!hello) {
      // The hook has not recorded a conversation yet (or the daemon was down).
      await deps.sleep(backoff(tries++), gone.signal);
      continue;
    }
    try {
      // The conversation again, as its hook said it: a restarted daemon has it back.
      const join = agyHello(conv as AgyConversation);
      if (join) await deps.rejoin(join).catch(() => {});
      const c = await deps.connect(hello);
      client = c;
      tries = 0;
      c.onAgyDeliver((f) => {
        void hand(f, c);
      });
      await new Promise<void>((resolve) => {
        c.onClose(resolve);
        gone.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      c.close();
      client = undefined;
    } catch (e) {
      if (e instanceof HelloRefused && e.reason === AGY_WATCHER_RUNNING) {
        deps.log("oa-bus agy-watch: already running for this session.");
        cleanup();
        return 0;
      }
      await deps.sleep(backoff(tries++), gone.signal);
    }
  }
  deps.log("oa-bus agy-watch: the Antigravity session ended; stopping.");
  cleanup();
  return 0;
}

const backoff = (n: number) =>
  BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)] as number;

/**
 * The agy binary to call: the agy process's own when ps names its path, else
 * `agy` on the PATH agy passed down.
 */
function agyBinary(agy: number, deps: AgyWatchDeps): string {
  const name = deps.proc(agy)?.name;
  return name?.startsWith("/") && isAgy(name) ? name : "agy";
}
