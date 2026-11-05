// The xt:live suite's fetch (flake server #2): every request is bounded, and
// an idempotent request (GET, HEAD, PUT, DELETE, OPTIONS) is retried on a
// thrown error (reset, timeout, "fetch failed") or a 502/503/504, the edge's
// "the Worker didn't answer". Never a 4xx, and never a POST: a code request
// or a publish sent twice is a different test.

/** Per attempt: the slowest install answers well inside it. */
export const LIVE_FETCH_TIMEOUT_MS = 10_000;
/** Attempts for an idempotent request (1 + 2 retries). */
export const LIVE_FETCH_TRIES = 3;
const RETRY_STATUS = new Set([502, 503, 504]);
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);

export async function liveFetch(
  req: Request,
  o: {
    fetch?: typeof fetch;
    timeoutMs?: number;
    tries?: number;
    backoffMs?: number;
  } = {},
): Promise<Response> {
  const f = o.fetch ?? fetch;
  const tries = IDEMPOTENT.has(req.method) ? (o.tries ?? LIVE_FETCH_TRIES) : 1;
  const ms = o.timeoutMs ?? LIVE_FETCH_TIMEOUT_MS;
  const backoff = o.backoffMs ?? 250;
  for (let i = 1; ; i++) {
    // Each attempt gets its own copy (a body is single-use) and bound.
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(ms)]);
    let res: Response;
    try {
      // (Node's Request; the workers types' Request differs only in `cf`.)
      res = await f(new Request(req.clone() as never, { signal }) as never);
    } catch (e) {
      if (i >= tries || req.signal.aborted) throw e;
      await new Promise((r) => setTimeout(r, backoff * i));
      continue;
    }
    if (!RETRY_STATUS.has(res.status) || i >= tries) return res;
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, backoff * i));
  }
}
