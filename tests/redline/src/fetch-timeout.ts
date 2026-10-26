// A per-request bound for every fetch in the live suite. A request that never
// answers would otherwise hold its case until vitest's testTimeout, and the
// fetch itself keeps running after the case fails. Bounded, a stalled request
// rejects with an abort error: a FAIL naming the case, never a refusal.

/** Default per-request bound; edge.test.ts keeps its own, shorter one. */
export const FETCH_TIMEOUT_MS = 30_000;

/** `inner` with a timeout signal added to every call, joined with the caller's. */
export function boundFetch(
  inner: typeof fetch,
  ms: number = FETCH_TIMEOUT_MS,
): typeof fetch {
  return (input, init) => {
    const own =
      init?.signal ?? (input instanceof Request ? input.signal : null);
    const timeout = AbortSignal.timeout(ms);
    const signal = own ? AbortSignal.any([own, timeout]) : timeout;
    return inner(input, { ...init, signal });
  };
}
