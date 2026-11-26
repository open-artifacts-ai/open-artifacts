// T19's reads survive a dropped connection, in the pattern #1152 gave the
// red-line suite (tests/redline/src/provisioning.ts, fetch-timeout.ts): an
// allow-side GET that got no response at all is sent again, a bounded few
// times, once the host answers /healthz again (no timed backoff), so a poll
// keeps polling. A write is never sent
// twice, with one exception: a caller may opt a request into the same bounded
// retry (`repeatable: true`), and only a route in REPEATABLE_WRITE_ROUTES is
// honoured. That list holds the session test hook alone, which is safe to
// repeat (apps/server/src/test-hooks/index.ts: the user insert is
// on-conflict-do-nothing, the space grants are same-role upserts, the cookie
// is a stateless signature). PATCH /api/v1/me and every other write stay one
// try. An answer that arrived (2xx, 4xx or 5xx) is returned as is, so a
// refusal can't turn into a pass.
//
// A request that got no response for a socket reason is thrown as InfraError,
// whose message names the network ("infra: no_response ECONNRESET ..."). That
// is a label on a failing test and nothing more: T19's Playwright result does
// not reach red-line's infra count (tests/redline src/report.ts), and the gate
// fails either way (#1596 follow-up). A reset on a write may mean the server
// ran it, so it stays a failing test and is never retried or passed (bar the
// allow-listed route above).

// One list of socket codes, shared with the red-line suite (net-codes.ts).
import { isNetworkError, noResponseCode } from "./net-codes";

export { isNetworkError, noResponseCode };

/** Sends of a retryable request: the first and up to two more (as tests/redline/src/http.ts). */
export const READ_TRIES = 3;
/** Most health asks before one resend: a host refusing at once is not asked in a busy loop. */
export const HEALTH_ASKS_MAX = 50;
/** How long to wait for the host to answer again before resending anyway. */
export const HEALTH_WAIT_MS = 10_000;

/** True when the host at `origin` answers GET /healthz with a 200 within `ms`. */
export async function hostHealthy(
  origin: string,
  ms: number,
): Promise<boolean> {
  try {
    const r = await fetch(`${origin}/healthz`, {
      signal: AbortSignal.timeout(ms),
    });
    await r.body?.cancel();
    return r.status === 200;
  } catch {
    return false;
  }
}

/**
 * A request that got no HTTP response for a socket reason (#1596). Names
 * itself as infra in its message, as tests/redline's "infra: no_response ..."
 * does. A label only: the test still fails and the gate fails with it. The
 * server may have run a write whose connection was reset.
 */
export class InfraError extends Error {
  constructor(reason: string, cause: unknown) {
    super(`infra: ${reason}`, { cause });
    this.name = "InfraError";
  }
}

/**
 * The only non-GET routes a caller may opt into the retry: the session test
 * hook (TEST_HOOKS.session), idempotent by construction. Never add a route
 * whose second run could differ from its first.
 */
export const REPEATABLE_WRITE_ROUTES: readonly string[] = ["/__test/session"];

const classify = (
  e: unknown,
  m: string,
  route: string | undefined,
  i: number,
) => {
  // Out of tries, or a write: a socket failure is infra, named. An HTTP
  // response never gets here; a timeout or abort keeps its own error.
  const code = noResponseCode(e);
  if (!code) return e;
  const tries = `${i + 1} ${i === 0 ? "try" : "tries"}`;
  return new InfraError(
    `no_response ${code} ${m} ${route ?? "?"} (${tries})`,
    e,
  );
};

/**
 * Sends a request through `send`, which builds a fresh one (and its timeout)
 * each call. A GET or HEAD (or an opted-in allow-listed route) that throws a
 * network error is sent again, up to READ_TRIES sends, after the host at
 * `origin` answers /healthz again (or HEALTH_WAIT_MS passes: each ask is a
 * request bounded by what is left, so nothing sleeps). Anything else, and any
 * response, goes back at once. Without an `origin` there is nothing to ask,
 * so a failed request is not sent again.
 */
export async function sendRead(
  method: string | undefined,
  send: () => Promise<Response>,
  o: {
    /** The host's origin: what to ask /healthz of before a resend. */
    origin?: string;
    tries?: number;
    /** Whether the host answers within `ms` (default: GET /healthz is a 200). */
    healthy?: (origin: string, ms: number) => Promise<boolean>;
    /** How long to wait for it (default HEALTH_WAIT_MS). */
    healthWaitMs?: number;
    /** The route, for the infra reason (never a query: it may hold a code). */
    route?: string;
    /** Opt in to the GET retry; ignored unless `route` is in REPEATABLE_WRITE_ROUTES. */
    repeatable?: boolean;
  } = {},
): Promise<Response> {
  const m = (method ?? "GET").toUpperCase();
  const retryable =
    m === "GET" ||
    m === "HEAD" ||
    (o.repeatable === true &&
      o.route !== undefined &&
      REPEATABLE_WRITE_ROUTES.includes(o.route));
  const tries = retryable && o.origin ? (o.tries ?? READ_TRIES) : 1;
  const healthy = o.healthy ?? hostHealthy;
  const untilHealthy = async (origin: string) => {
    const end = Date.now() + (o.healthWaitMs ?? HEALTH_WAIT_MS);
    for (let n = 0; n < HEALTH_ASKS_MAX && Date.now() < end; n++)
      if (await healthy(origin, end - Date.now())) return;
  };
  for (let i = 1; ; i++) {
    try {
      return await send();
    } catch (e) {
      if (i >= tries || !isNetworkError(e))
        throw classify(e, m, o.route, i - 1);
      await untilHealthy(o.origin as string);
    }
  }
}

/**
 * A paced hook POST: `pace` (the hook-ledger slot claim) runs inside each
 * attempt, so a retry after a reset claims its own slot, as the server's
 * RL_ANON spends one per attempt. Only the session hook is repeatable.
 */
export function sendPacedHook(
  route: string,
  pace: () => Promise<unknown>,
  send: () => Promise<Response>,
  o: Parameters<typeof sendRead>[2] = {},
): Promise<Response> {
  return sendRead(
    "POST",
    async () => {
      await pace();
      return send();
    },
    { ...o, route, repeatable: true },
  );
}
