// T19's reads survive a dropped connection, in the pattern #1152 gave the
// red-line suite (tests/redline/src/provisioning.ts, fetch-timeout.ts): an
// allow-side GET that got no response at all is sent again, a bounded few
// times with a short backoff, so a poll keeps polling. A write is never sent
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

/** The waits before the second and third tries, as in tests/redline/src/http.ts. */
export const READ_BACKOFF_MS = [250, 1000] as const;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends a request through `send`, which builds a fresh one (and its timeout)
 * each call. A GET or HEAD (or an opted-in allow-listed route) that throws a network error is sent again after
 * each `backoff` wait; anything else, and any response, goes back at once.
 */
export async function sendRead(
  method: string | undefined,
  send: () => Promise<Response>,
  o: {
    backoff?: readonly number[];
    wait?: (ms: number) => Promise<void>;
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
  const backoff = retryable ? (o.backoff ?? READ_BACKOFF_MS) : [];
  const wait = o.wait ?? sleep;
  for (let i = 0; ; i++) {
    try {
      return await send();
    } catch (e) {
      const ms = backoff[i];
      if (ms === undefined || !isNetworkError(e)) {
        // Out of tries, or a write: a socket failure is infra, named. An HTTP
        // response never gets here; a timeout or abort keeps its own error.
        const code = noResponseCode(e);
        if (!code) throw e;
        const tries = `${i + 1} ${i === 0 ? "try" : "tries"}`;
        throw new InfraError(
          `no_response ${code} ${m} ${o.route ?? "?"} (${tries})`,
          e,
        );
      }
      await wait(ms);
    }
  }
}
