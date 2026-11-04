import { connect, type Socket } from "node:net";
import {
  CLIENT_VERSION,
  DaemonFrame,
  type Hello,
  type StatusReply,
} from "./frames.ts";
import { LineDecoder } from "./lines.ts";

export type DaemonClient = {
  welcome: Extract<DaemonFrame, { type: "welcome" }>;
  state: "open" | "closed";
  request: (frame: {
    type: "list" | "self" | "send" | "fetch" | "set_status";
    id?: string;
    to?: string;
    /** send: the target's namespace (`to_namespace` on the hub wire). */
    namespace?: string;
    body?: string;
    msg_id?: string;
    /** set_status: one of STATUS_STATES, and an optional label. */
    state?: string;
    label?: string;
    /** self: also the agent's status, from its hub roster row. */
    row?: true;
    /** A tool call: the reply carries this agent's late-delivery notices. */
    late?: true;
  }) => Promise<DaemonFrame>;
  /** Confirms a delivery was injected. Fire-and-forget: the daemon sends no reply. */
  ack: (msg_id: string) => void;
  onDeliver: (
    cb: (frame: Extract<DaemonFrame, { type: "deliver" }>) => void,
  ) => void;
  /** Open Artifacts bus notices (expired or refused mail) the daemon pushes to this session. */
  onNotice: (cb: (text: string) => void) => void;
  close: () => void;
};

/** The daemon answered hello with something other than welcome: `reason` is its message. */
export class HelloRefused extends Error {
  readonly frame: DaemonFrame;
  readonly reason: string | undefined;
  constructor(frame: DaemonFrame) {
    super(`daemon refused hello: ${JSON.stringify(frame)}`);
    this.frame = frame;
    this.reason = frame.type === "error" ? frame.message : undefined;
  }
}

export async function connectDaemon(opts: {
  path: string;
  hello: Hello;
  timeoutMs?: number;
  /** A request the daemon has not answered by then rejects. Default 20 s: above the daemon's 10 s hub wait plus its 5 s wait for delivered. */
  requestTimeoutMs?: number;
  /** Receives errors thrown by the onDeliver callback; defaults to console.error. */
  onError?: (e: unknown) => void;
}): Promise<DaemonClient> {
  const sock: Socket = connect(opts.path);
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  const decoder = new LineDecoder();
  let state: "open" | "closed" = "open";
  let seq = 0;
  type Waiter = {
    resolve: (f: DaemonFrame) => void;
    reject: (e: Error) => void;
  };
  const pending = new Map<string, Waiter>();
  const waiters: Waiter[] = [];
  type Deliver = Extract<DaemonFrame, { type: "deliver" }>;
  let deliver: ((f: Deliver) => void) | undefined;
  const early: Deliver[] = [];
  let notice: ((text: string) => void) | undefined;
  const earlyNotices: string[] = [];
  const report =
    opts.onError ?? ((e: unknown) => console.error("onDeliver threw", e));
  const dispatch = (f: Deliver) => {
    try {
      deliver?.(f);
    } catch (e) {
      report(e);
    }
  };

  const failAll = (err: Error) => {
    state = "closed";
    for (const w of [...pending.values(), ...waiters.splice(0)]) w.reject(err);
    pending.clear();
  };

  sock.on("data", (chunk) => {
    try {
      for (const raw of decoder.push(chunk)) {
        const frame = DaemonFrame.parse(raw);
        if (frame.type === "deliver") {
          if (deliver) dispatch(frame);
          else early.push(frame);
          continue;
        }
        if (frame.type === "notice") {
          if (notice) {
            try {
              notice(frame.text);
            } catch (e) {
              report(e);
            }
          } else earlyNotices.push(frame.text);
          continue;
        }
        const waiter = pending.get(frame.id);
        if (waiter) {
          pending.delete(frame.id);
          waiter.resolve(frame);
          continue;
        }
        waiters.shift()?.resolve(frame);
      }
    } catch (e) {
      failAll(e instanceof Error ? e : new Error(String(e)));
      sock.destroy();
    }
  });
  sock.on("error", (e) => failAll(e));
  sock.on("close", () => failAll(new Error("daemon connection closed")));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const welcomeRaw = await new Promise<DaemonFrame>((resolve, reject) => {
    waiters.push({ resolve, reject });
    timer = setTimeout(() => {
      reject(new Error("daemon did not answer hello"));
      sock.destroy();
    }, opts.timeoutMs ?? 5000);
    sock.write(`${JSON.stringify(opts.hello)}\n`);
  }).finally(() => clearTimeout(timer));
  if (welcomeRaw.type !== "welcome") {
    sock.destroy();
    throw new HelloRefused(welcomeRaw);
  }
  const welcome = welcomeRaw;

  return {
    welcome,
    get state() {
      return state;
    },
    request: (partial) => {
      if (state === "closed")
        return Promise.reject(new Error("daemon connection closed"));
      const id = partial.id ?? String(++seq);
      return new Promise((resolve, reject) => {
        const ms = opts.requestTimeoutMs ?? 20_000;
        const timer = setTimeout(() => {
          // A late answer for this id is then dropped as unmatched.
          if (pending.delete(id))
            reject(
              new Error(
                `daemon request ${partial.type} timed out after ${ms} ms`,
              ),
            );
        }, ms);
        timer.unref?.();
        const done =
          <A extends unknown[]>(f: (...a: A) => void) =>
          (...a: A) => {
            clearTimeout(timer);
            f(...a);
          };
        pending.set(id, { resolve: done(resolve), reject: done(reject) });
        sock.write(`${JSON.stringify({ v: 1, ...partial, id })}\n`);
      });
    },
    ack: (msg_id) => {
      if (state === "closed") return;
      sock.write(
        `${JSON.stringify({ v: 1, type: "ack", id: `ack-${++seq}`, msg_id })}\n`,
      );
    },
    onDeliver: (cb) => {
      deliver = cb;
      for (const f of early.splice(0)) dispatch(f);
    },
    onNotice: (cb) => {
      notice = cb;
      for (const t of earlyNotices.splice(0)) cb(t);
    },
    close: () => sock.destroy(),
  };
}

/**
 * The socket took the connection but no usable status came back: silence,
 * a close, an error frame or garbage. Something listens, so the daemon is
 * running; it is stalled or confused, not missing.
 */
export class DaemonSilentError extends Error {
  override name = "DaemonSilentError";
}

/** Connect errors that mean no daemon listens; any other socket error came after it accepted. */
const NOT_LISTENING = new Set([
  "ENOENT",
  "ECONNREFUSED",
  "ENOTDIR",
  "EACCES",
  "ENOTSOCK",
]);

/** Asks the daemon how it is, without a hello. Rejects if it does not answer in time. */
export function daemonStatus(opts: {
  path: string;
  cwd?: string;
  timeoutMs?: number;
}): Promise<StatusReply> {
  return new Promise((resolve, reject) => {
    const sock = connect(opts.path);
    const decoder = new LineDecoder();
    const done = (f: () => void) => {
      clearTimeout(timer);
      sock.destroy();
      f();
    };
    const timer = setTimeout(
      () =>
        done(() =>
          reject(new DaemonSilentError("daemon did not answer status")),
        ),
      opts.timeoutMs ?? 2000,
    );
    sock.once("error", (e: NodeJS.ErrnoException) =>
      done(() =>
        reject(
          NOT_LISTENING.has(e.code ?? "")
            ? e
            : new DaemonSilentError(e.message),
        ),
      ),
    );
    sock.once("close", () =>
      done(() => reject(new DaemonSilentError("daemon connection closed"))),
    );
    sock.once("connect", () =>
      sock.write(
        `${JSON.stringify({ v: 1, id: "status", type: "status", client_version: CLIENT_VERSION, ...(opts.cwd ? { cwd: opts.cwd } : {}) })}\n`,
      ),
    );
    sock.on("data", (chunk) => {
      try {
        for (const raw of decoder.push(chunk)) {
          const f = DaemonFrame.parse(raw);
          if (f.type === "status") return done(() => resolve(f));
          if (f.type === "error")
            return done(() =>
              reject(
                new DaemonSilentError(`daemon refused status: ${f.message}`),
              ),
            );
        }
      } catch (e) {
        done(() =>
          reject(
            new DaemonSilentError(e instanceof Error ? e.message : String(e)),
          ),
        );
      }
    });
  });
}
