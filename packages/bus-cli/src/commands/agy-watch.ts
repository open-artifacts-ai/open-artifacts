import { type ChildProcess, execFile } from "node:child_process";
import {
  type AgyConversation,
  type AgyMailboxState,
  AgySentIds,
  agyAppDataDir,
  agyHello,
  agyMailboxHas,
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

/** What is known of an earlier hand-off's `agy agentapi` process. */
export type AgyChildState = "running" | "gone" | "unknown";

/** `ok: false` with `unknown` when the call may have reached agy (a timeout or a signal). */
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
  /**
   * `agy agentapi send-message <conversation> <text>`, with agy's own env.
   * `started` gets the call's pid as soon as the process exists, before it
   * may call agy: it runs agy only once `started` returned true (its pid and
   * start time are written down), and ends without calling agy otherwise,
   * or when the watcher dies first.
   */
  send: (
    agyBin: string,
    conversation: string,
    text: string,
    started?: (pid: number) => boolean,
  ) => Promise<SendResult>;
  /**
   * Whether an earlier hand-off's call (`pid`, and its start time, "" when
   * it could not be read) still runs: "gone" only when provably so (no such
   * pid, or another process's start time); "unknown" when it can't be told.
   */
  childState: (pid: number, start: string) => AgyChildState;
  /** The watcher's own link to the daemon. */
  connect: (hello: Hello) => Promise<DaemonClient>;
  /** The hook's hello for a conversation: joins it again after a daemon restart. */
  rejoin: (hello: Hello) => Promise<void>;
  /** Resolves after `ms`, or at once when `abort` fires. */
  sleep: (ms: number, abort: AbortSignal) => Promise<void>;
  /**
   * Whether agy's own mailbox holds this bus message for the conversation:
   * agy's receipt, written before agentapi returns.
   */
  mailbox: (conversation: string, msgId: string) => AgyMailboxState;
  /** Now, in ms. */
  now: () => number;
  /** Calls `fn` every `ms` until the returned stop is called. */
  every: (ms: number, fn: () => void) => () => void;
  log: (line: string) => void;
  /** Runs `fn` when the process is told to stop (agy ends its background task). */
  onStop: (fn: () => void) => void;
};

/**
 * One line of agy's error, for the watcher's own output (which the session
 * reads): agy's agentapi address and token taken out, should agy ever echo them.
 */
export function agyErrorLine(
  text: string,
  env: Record<string, string | undefined>,
): string {
  let line = text.split("\n")[0] ?? "";
  for (const k of ["ANTIGRAVITY_CSRF_TOKEN", "ANTIGRAVITY_LS_ADDRESS"]) {
    const v = env[k];
    if (v) line = line.replaceAll(v, `<${k}>`);
  }
  return line.slice(0, 200);
}

/** The `agy agentapi` calls running now: a stopping watcher ends them first. */
const inFlight = new Set<ChildProcess>();

/** The exit status of a call its gate stopped before it ran agy. */
export const AGY_GATE_CLOSED = 97;
/**
 * The call's gate: a shell that runs agy (`exec`, same pid and start time)
 * only after the watcher wrote "go" on its stdin, which it does once the
 * call's pid and start time are on disk. A watcher that dies first closes
 * the pipe, and the call ends without reaching agy. So a hand-off record
 * without a call in it never reached agy (#3205 review, gap A).
 */
const AGY_GATE = `IFS= read -r go || exit ${AGY_GATE_CLOSED}; [ "$go" = go ] || exit ${AGY_GATE_CLOSED}; exec "$@"`;

export const execSend =
  (
    env: Record<string, string | undefined>,
    shell = "/bin/sh",
  ): AgyWatchDeps["send"] =>
  (bin, conversation, text, started) =>
    new Promise((resolve) => {
      let opened = false;
      const child = execFile(
        shell,
        [
          "-c",
          AGY_GATE,
          "oa-bus-agy-send",
          bin,
          "agentapi",
          "send-message",
          `--title=${AGY_MESSAGE_TITLE}`,
          conversation,
          text,
        ],
        // agy's own env: its agentapi address and token, never printed.
        { env, timeout: SEND_TIMEOUT_MS, maxBuffer: 256 * 1024 },
        (err, _stdout, stderr) => {
          inFlight.delete(child);
          if (!err) return resolve({ ok: true });
          const e = err as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: string | null;
          };
          if (!opened && (err as { code?: unknown }).code === AGY_GATE_CLOSED)
            return resolve({
              ok: false,
              detail: "stopped before agy was called",
            });
          resolve({
            ok: false,
            // Ended by a signal (our timeout or anyone's): it may have reached agy.
            ...(e.killed || e.signal ? { unknown: true as const } : {}),
            detail: agyErrorLine(String(stderr || e.message), env),
          });
        },
      );
      inFlight.add(child);
      try {
        opened =
          child.pid !== undefined && (started ? started(child.pid) : true);
      } catch {
        opened = false;
      }
      // "go" only once the call is written down; else EOF, and agy is never called.
      child.stdin?.on("error", () => {});
      child.stdin?.end(opened ? "go\n" : "");
    });

/**
 * The default AgyWatchDeps.childState: `kill(pid, 0)` says whether the pid
 * exists at all, ps's start time whether it is still that call.
 */
export function agyChildState(
  pid: number,
  start: string,
  procStart: (pid: number) => string | null,
  exists: (pid: number) => boolean = pidExists,
): AgyChildState {
  if (!exists(pid)) return "gone";
  let now: string | null;
  try {
    now = procStart(pid);
  } catch {
    return "unknown";
  }
  // ps could not say: gone only if the pid has gone meanwhile.
  if (now === null) return exists(pid) ? "unknown" : "gone";
  // Its start time was never read: this pid may still be that call.
  if (start === "") return "unknown";
  return now === start ? "running" : "gone";
}

/** False only on ESRCH: any other answer (EPERM, …) means it may exist. */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const defaults = (ctx: Ctx): AgyWatchDeps => ({
  proc: readProc,
  procStart: procStartOf,
  ppid: process.ppid,
  pid: process.pid,
  env: process.env,
  send: execSend(process.env),
  childState: (pid, start) => agyChildState(pid, start, procStartOf),
  mailbox: (conversation, msgId) =>
    agyMailboxHas(
      agyAppDataDir(process.env),
      conversation,
      AGY_MESSAGE_TITLE,
      msgId,
    ),
  now: Date.now,
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
        // An agentapi call left running could reach agy after the next
        // watcher found agy's mailbox without it, and agy would get it twice.
        for (const c of inFlight) c.kill("SIGKILL");
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
 * turn gets it at its next tool step, an idle session wakes. A message is
 * acked (delivered) only when agy says it took it: agentapi's success, or
 * agy's own mailbox holding it. An id an earlier watcher may have handed
 * over is sent again only when that mailbox shows agy does not have it, and
 * answered "unknown" when the mailbox cannot be read. It exits when its agy
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

  /**
   * One push. `delivered` (ack) only on agy's word: agentapi said it took
   * the message, or agy's mailbox holds it. An id an earlier hand-off may
   * have reached agy with is never sent again before the mailbox says agy
   * does not have it; when the mailbox cannot say, the answer is "unknown"
   * and the receipt stays pending.
   */
  const hand = async (f: AgyDeliver, via: DaemonClient) => {
    const id = f.msg_id;
    if (handing.has(id)) return;
    // Only the conversation the hook recorded for this agy process, ever.
    const conv = readAgyConversation(ctx.home, agy);
    if (
      !conv ||
      conv.procStart !== agyStart ||
      conv.conversationId !== f.conversation_id
    ) {
      deps.log(
        `oa-bus agy-watch: ${id} is for another conversation; not handed on`,
      );
      return via.agyFailed(id);
    }
    // agentapi said agy took it (the watcher stopped before it acked).
    if (sent.has(id)) return via.ack(id);
    handing.add(id);
    const to = () => client ?? via;
    const box = () => deps.mailbox(f.conversation_id, id);
    const took = (why: string) => {
      sent.add(id);
      deps.log(`oa-bus agy-watch: delivered ${id}${why}`);
      to().ack(id);
    };
    const unknown = (why: string) => {
      deps.log(
        `oa-bus agy-watch: ${id} may have reached agy (${why}); not sent again, not called delivered`,
      );
      to().agyUnknown(id);
    };
    try {
      const since = sent.tryingSince(id);
      if (since !== undefined) {
        // An earlier watcher began this hand-off and never wrote agy's
        // answer down. Its agy call ends within SEND_TIMEOUT_MS; only then
        // is agy's mailbox the whole story.
        const left = since + SEND_TIMEOUT_MS - deps.now();
        if (left > 0) await deps.sleep(left, gone.signal);
      }
      const before = box();
      if (before === "present") return took(" (agy already had it)");
      if (since !== undefined) {
        if (before === "unreadable")
          return unknown("agy's mailbox cannot be read");
        // A watcher killed outright leaves its agentapi call running, with
        // no timeout: until that process is provably gone it may still
        // reach agy. No call recorded: it never got past its gate, so it
        // never called agy (execSend).
        const c = sent.tryingChild(id);
        const state = c ? deps.childState(c.pid, c.start) : "gone";
        if (state === "running")
          return unknown("an earlier agy call still runs");
        if (state === "unknown")
          return unknown("an earlier agy call may still run");
      }
      // Written first: a watcher that dies mid-call leaves the mark behind.
      sent.begin(id, deps.now());
      const r = await deps.send(agyBin, f.conversation_id, f.text, (pid) => {
        // The call runs agy only once this is on disk.
        let start = "";
        try {
          start = deps.procStart(pid) ?? "";
        } catch {
          // Unreadable: recorded as "", which a replay treats as unclear.
        }
        sent.child(id, pid, start);
        return true;
      });
      if (r.ok) return took("");
      const after = box();
      if (after === "present") return took(" (agy has it)");
      if (r.unknown) return unknown(r.detail);
      if (after === "unreadable")
        return unknown(`${r.detail}; agy's mailbox cannot be read`);
      // agy said no: nothing of it reached the session; the daemon retries.
      sent.delete(id);
      deps.log(`oa-bus agy-watch: agy did not take ${id}: ${r.detail}`);
      to().agyFailed(id);
    } finally {
      handing.delete(id);
    }
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
      // Only once the daemon took this watcher: a start it refused (another
      // runs) never names itself here, so its cleanup never clears the
      // running one's file. The hook reads this file to tell one runs.
      if (selfStart !== null)
        writeAgyWatch(ctx.home, agy, {
          pid: deps.pid,
          procStart: selfStart,
          agyStart,
        });
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
