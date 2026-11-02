// Evidence for #1133: what a connection reset looked like. Each one becomes a
// note with the method, the route's first segments, the host's hash and
// whether the socket was new or reused, and how long it had sat idle. The
// file's totals go with them: "resets hit reused sockets" means nothing unless
// you know how many requests did. Node's own diagnostics channels, read only:
// no request is changed. Logs are public: no full path, query or host name.
import { createHash } from "node:crypto";
import { subscribe } from "node:diagnostics_channel";
import { networkCode } from "./fetch-timeout.ts";
import { note } from "./notes.ts";

const RESET_PREFIX = "reset: ";
const CONNECTIONS_PREFIX = "connections: ";

type Req = { method?: string; origin?: unknown; path?: string };
type Sent = { reused: boolean; idleMs: number; nth: number };
type Sock = { requests: number; lastDone: number };

/** The route, not the resource: ids sit past the third segment. */
const routeOf = (path = ""): string =>
  path.split("?")[0]?.split("/").slice(0, 4).join("/") ?? "";

const hostOf = (origin: unknown): string =>
  createHash("sha256").update(String(origin)).digest("hex").slice(0, 8);

export function watchResets(now: () => number = Date.now): {
  /** This file's totals, as a note's text. */
  totals: () => string;
} {
  const sockets = new WeakMap<object, Sock>();
  const sent = new WeakMap<object, Sent>();
  let requests = 0;
  let fresh = 0;
  subscribe("undici:client:sendHeaders", (m) => {
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
    sent.set(request, {
      reused,
      idleMs: reused ? now() - s.lastDone : 0,
      nth: s.requests,
    });
    (request as { socket?: object }).socket = socket;
  });
  subscribe("undici:request:trailers", (m) => {
    const { request } = m as { request: { socket?: object } };
    const s = request.socket && sockets.get(request.socket);
    if (s) s.lastDone = now();
  });
  subscribe("undici:request:error", (m) => {
    const { request, error } = m as { request: Req; error: unknown };
    // Our own bound (src/fetch-timeout.ts) or a caller's abort: not a reset.
    const name = (error as Error).name;
    if (name === "AbortError" || name === "TimeoutError") return;
    const s = sent.get(request);
    const where = `${request.method} ${routeOf(request.path)} host ${hostOf(request.origin)}`;
    note(
      s
        ? `${RESET_PREFIX}${networkCode(error)} ${where}, ${s.reused ? `reused socket, idle ${s.idleMs} ms, request ${s.nth} on it` : "new socket"}`
        : `${RESET_PREFIX}${networkCode(error)} ${where}, before the request was sent`,
    );
  });
  return {
    totals: () =>
      `${CONNECTIONS_PREFIX}${requests} requests, ${fresh} on new sockets`,
  };
}
