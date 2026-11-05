// Evidence for #1133: what a connection reset looked like. Each one becomes a
// note with the method, the route's first segments, the host's hash and
// whether the socket was new or reused, and how long it had sat idle. The
// file's totals go with them: "resets hit reused sockets" means nothing unless
// you know how many requests did. Node's own diagnostics channels, read only:
// no request is changed, and no header or body is read. Logs are public: no
// full path, query or host name.
//
// It also tells src/transport.ts which socket a fetch went out on: a fetch
// run under track() gets the sent record of its own undici request, matched
// by the AsyncLocalStorage context the request was created in.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { subscribe } from "node:diagnostics_channel";
import { networkCode } from "./fetch-timeout.ts";
import { note } from "./notes.ts";

const RESET_PREFIX = "reset: ";
const CONNECTIONS_PREFIX = "connections: ";

type Req = { method?: string; origin?: unknown; path?: string };
export type Sent = { reused: boolean; idleMs: number; nth: number };
type Sock = { requests: number; lastDone: number };
/** One fetch attempt under track(): its socket, once its headers went out. */
export type Attempt = { sent?: Sent };

/** The route, not the resource: ids sit past the third segment. */
export const routeOf = (path = ""): string =>
  path.split("?")[0]?.split("/").slice(0, 4).join("/") ?? "";

export const hostOf = (origin: unknown): string =>
  createHash("sha256").update(String(origin)).digest("hex").slice(0, 8);

/** How a reset note names the socket. */
export const socketText = (s: Sent | undefined): string =>
  s
    ? s.reused
      ? `reused socket, idle ${s.idleMs} ms, request ${s.nth} on it`
      : "new socket"
    : "before the request was sent";

export interface ResetWatch {
  /** This file's totals, as a note's text. */
  totals: () => string;
  /** Runs `f`; `a.sent` is set when the fetch it starts sends its headers. */
  track: <T>(a: Attempt, f: () => T) => T;
}

export function watchResets(now: () => number = Date.now): ResetWatch {
  const sockets = new WeakMap<object, Sock>();
  const sent = new WeakMap<object, Sent>();
  const socketOf = new WeakMap<object, object>();
  const attempts = new AsyncLocalStorage<Attempt>();
  const attemptOf = new WeakMap<object, Attempt>();
  let requests = 0;
  let fresh = 0;
  // A listener that throws would surface as an uncaught error and fail a
  // case. Evidence is never worth that: it drops the record instead.
  const on = (channel: string, f: (m: unknown) => void) =>
    subscribe(channel, (m) => {
      try {
        f(m);
      } catch {}
    });
  // Published while dispatching, in the context of the fetch that made it.
  on("undici:request:create", (m) => {
    const a = attempts.getStore();
    if (a) attemptOf.set((m as { request: object }).request, a);
  });
  on("undici:client:sendHeaders", (m) => {
    const { request, socket } = m as { request: Req; socket: object };
    let s = sockets.get(socket);
    const reused = s !== undefined;
    if (!s) {
      s = { requests: 0, lastDone: now() };
      sockets.set(socket, s);
      fresh++;
    }
    s.requests++;
    requests++;
    const record = {
      reused,
      idleMs: reused ? now() - s.lastDone : 0,
      nth: s.requests,
    };
    sent.set(request, record);
    const a = attemptOf.get(request);
    if (a) a.sent = record;
    socketOf.set(request, socket);
  });
  on("undici:request:trailers", (m) => {
    const { request } = m as { request: object };
    const socket = socketOf.get(request);
    const s = socket && sockets.get(socket);
    if (s) s.lastDone = now();
  });
  on("undici:request:error", (m) => {
    const { request, error } = m as { request: Req; error: unknown };
    // Our own bound (src/fetch-timeout.ts) or a caller's abort: not a reset.
    const name = (error as Error).name;
    if (name === "AbortError" || name === "TimeoutError") return;
    const s = sent.get(request);
    const where = `${request.method} ${routeOf(request.path)} host ${hostOf(request.origin)}`;
    note(`${RESET_PREFIX}${networkCode(error)} ${where}, ${socketText(s)}`);
  });
  return {
    totals: () =>
      `${CONNECTIONS_PREFIX}${requests} requests, ${fresh} on new sockets`,
    track: (a, f) => attempts.run(a, f),
  };
}
