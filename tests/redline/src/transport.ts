// A transport blip never decides the gate (#1133). Every live fetch goes
// through transportFetch (live/setup.ts):
// - A request that gets no HTTP response for a socket reason (ECONNRESET,
//   UND_ERR_SOCKET, ...: noResponseCode) is tagged as infra on the error
//   itself, so a case that fails on it reports "infra", never "fail". The
//   error is otherwise unchanged: callers that expect no connection, or that
//   retry on their own, still read its message and cause.
// - Never on an HTTP response of any status, an abort or timeout (ours or a
//   caller's), a TLS failure, or an assertion: those keep their own verdict.
// - One retry, on a new connection, only when the failed attempt went out on
//   a reused socket (src/resets.ts) and the request is safe to repeat: GET,
//   HEAD, OPTIONS, or a call marked with idempotent() at its call site. Every
//   retry is a note on the case and counted on the report's Resets line.
// No case is ever re-run here.

import { networkCode, noResponseCode } from "./fetch-timeout.ts";
import { note } from "./notes.ts";
import {
  INFRA_PREFIX,
  NO_RESPONSE_KEY,
  RECOVERED_SUFFIX,
  RETRIED_REQUEST_PREFIX,
} from "./report.ts";
import {
  type Attempt,
  hostOf,
  type ResetWatch,
  routeOf,
  socketText,
} from "./resets.ts";

/** Methods a server must treat as safe to repeat (RFC 9110 9.2.2). */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const marked = new WeakSet<object>();

/**
 * Marks a request (a Request, or the init passed with it) as safe to send
 * twice. Only for a call whose repeat the server treats as a no-op; say why
 * in a comment at the call site.
 */
export function idempotent<T extends Request | RequestInit>(x: T): T {
  marked.add(x);
  return x;
}

/** A dispatcher fetch accepts (undici's), closed once its request is done. */
export interface FreshDispatcher {
  close(): Promise<unknown>;
}

/**
 * A new connection pool of the kind fetch already uses: a new Agent from the
 * global dispatcher's own class, so the retry can't reuse the pool's sockets.
 * Undefined before the first fetch set the global dispatcher up.
 */
export function freshAgent(): FreshDispatcher | undefined {
  const g = (globalThis as Record<symbol, unknown>)[
    Symbol.for("undici.globalDispatcher.1")
  ] as { constructor?: unknown } | undefined;
  const Agent = g?.constructor;
  return typeof Agent === "function" && Agent !== Object
    ? new (Agent as new () => FreshDispatcher)()
    : undefined;
}

/** Tags `e` (unchanged otherwise) as infra and returns it to throw. */
function tag(e: unknown, reason: string): unknown {
  try {
    (e as Record<string, unknown>)[NO_RESPONSE_KEY] =
      `${INFRA_PREFIX}no_response ${reason}`;
  } catch {}
  return e;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  return (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
}

function urlOf(input: RequestInfo | URL): URL | undefined {
  try {
    return new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return undefined;
  }
}

/** Why the request may not be sent twice, or undefined when it may. */
function notRepeatable(
  method: string,
  input: RequestInfo | URL,
  init?: RequestInit,
): string | undefined {
  // A stream body can't be sent again.
  if (init?.body instanceof ReadableStream) return "a stream body";
  if (SAFE_METHODS.has(method)) return undefined;
  if (
    (init && marked.has(init)) ||
    (input instanceof Request && marked.has(input))
  )
    return undefined;
  return `${method} is not safe to repeat`;
}

/**
 * `inner` with no-response errors tagged as infra, and one retry on a new
 * connection for a safe request that failed on a reused socket.
 */
export function transportFetch(
  inner: typeof fetch,
  watch: Pick<ResetWatch, "track">,
  o: { fresh?: () => FreshDispatcher | undefined } = {},
): typeof fetch {
  const fresh = o.fresh ?? freshAgent;
  return async (input, init) => {
    const method = methodOf(input, init);
    const why = notRepeatable(method, input, init);
    // The copy to send again (a Request's body is single-use).
    const spare = !why && input instanceof Request ? input.clone() : input;
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : null);
    const first: Attempt = {};
    try {
      return await watch.track(first, () => inner(input, init));
    } catch (e) {
      const code = noResponseCode(e);
      if (!code || signal?.aborted) throw e;
      const u = urlOf(input);
      const where = `${code} ${method} ${routeOf(u?.pathname)} host ${hostOf(u?.origin)}, ${socketText(first.sent)}`;
      const skip =
        why ?? (first.sent?.reused ? undefined : "not on a reused socket");
      if (skip) throw tag(e, `${where}; not retried: ${skip}`);
      const agent = fresh();
      if (!agent) throw tag(e, `${where}; not retried: no new connection`);
      const second: Attempt = {};
      try {
        const res = await watch.track(second, () =>
          inner(spare, { ...init, dispatcher: agent } as RequestInit),
        );
        note(`${RETRIED_REQUEST_PREFIX}${where}${RECOVERED_SUFFIX}`);
        return res;
      } catch (e2) {
        note(
          `${RETRIED_REQUEST_PREFIX}${where}; failed again (${networkCode(e2)}, ${socketText(second.sent)})`,
        );
        const code2 = noResponseCode(e2);
        if (!code2 || signal?.aborted) throw e2;
        throw tag(
          e2,
          `${where}; retried once on a new connection, ${code2} again (${socketText(second.sent)})`,
        );
      } finally {
        // Graceful: the response's body is still read through it.
        agent.close().catch(() => {});
      }
    }
  };
}
