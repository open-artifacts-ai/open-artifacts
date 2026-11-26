// The xt:live suite's fetch (flake server #2): every request is bounded, and
// an idempotent request (GET, HEAD, PUT, DELETE, OPTIONS) is retried on a
// thrown error (reset, timeout, "fetch failed") or a 502/503/504, the edge's
// "the Worker didn't answer". Never a 4xx, and never a POST: a code request
// or a publish sent twice is a different test. Before a retry it waits for the
// host to answer GET /healthz again (no timed backoff), then resends.

import { vi } from "vitest";

/** Per attempt: the slowest install answers well inside it. */
export const LIVE_FETCH_TIMEOUT_MS = 10_000;
/** Attempts for an idempotent request (1 + 2 retries). */
export const LIVE_FETCH_TRIES = 3;
const RETRY_STATUS = new Set([502, 503, 504]);
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);

/** True when the host at `origin` answers /healthz with a 200. */
async function hostHealthy(
  f: typeof fetch,
  origin: string,
  ms: number,
): Promise<boolean> {
  try {
    const r = await f(`${origin}/healthz`, { signal: AbortSignal.timeout(ms) });
    await r.body?.cancel();
    return r.status === 200;
  } catch {
    return false;
  }
}

export async function liveFetch(
  req: Request,
  o: {
    fetch?: typeof fetch;
    timeoutMs?: number;
    tries?: number;
    /** Whether the host answers again (default: GET /healthz is a 200). */
    healthy?: (origin: string) => Promise<boolean>;
    /** How often the health answer is asked (default 250 ms). */
    healthPollMs?: number;
    /** How long to wait for it before resending anyway (default: one attempt's bound). */
    healthWaitMs?: number;
  } = {},
): Promise<Response> {
  const f = o.fetch ?? fetch;
  const tries = IDEMPOTENT.has(req.method) ? (o.tries ?? LIVE_FETCH_TRIES) : 1;
  const ms = o.timeoutMs ?? LIVE_FETCH_TIMEOUT_MS;
  const healthy = o.healthy ?? ((origin) => hostHealthy(f, origin, ms));
  /**
   * Waits until the host answers, for at most healthWaitMs (one attempt's
   * bound by default) of Date time, then lets the caller resend. The bound is
   * read from the clock inside the poll, so a test's fake clock drives it
   * (vi.waitFor's own timeout is real time; it only backstops here).
   */
  const untilHealthy = () => {
    const waitMs = o.healthWaitMs ?? ms;
    const start = Date.now();
    return vi
      .waitFor(
        async () => {
          // Still down after the bound: the resend itself reports it.
          if (Date.now() - start >= waitMs) return;
          if (!(await healthy(new URL(req.url).origin)))
            throw new Error("host not answering yet");
        },
        { timeout: waitMs + 5_000, interval: o.healthPollMs ?? 250 },
      )
      .catch(() => undefined);
  };
  for (let i = 1; ; i++) {
    // Each attempt gets its own copy (a body is single-use) and bound.
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(ms)]);
    let res: Response;
    try {
      // (Node's Request; the workers types' Request differs only in `cf`.)
      res = await f(new Request(req.clone() as never, { signal }) as never);
    } catch (e) {
      if (i >= tries || req.signal.aborted) throw e;
      await untilHealthy();
      continue;
    }
    if (!RETRY_STATUS.has(res.status) || i >= tries) return res;
    await res.body?.cancel();
    await untilHealthy();
  }
}
