// T19's reads survive a dropped connection, in the pattern #1152 gave the
// red-line suite (tests/redline/src/provisioning.ts, fetch-timeout.ts): an
// allow-side GET that got no response at all is sent again, a bounded few
// times with a short backoff, so a poll keeps polling. A write is never sent
// twice, and an answer that arrived (2xx, 4xx or 5xx) is returned as is, so a
// refusal can't turn into a pass.

/** The waits before the second and third tries, as in tests/redline/src/http.ts. */
export const READ_BACKOFF_MS = [250, 1000] as const;

const NET_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CLOSED",
]);

/**
 * True when `e` means the request got no response: undici's TypeError "fetch
 * failed" or "terminated", a socket code, or an abort or timeout. Never an
 * HTTP status. A copy of tests/redline/src/fetch-timeout.ts isNetworkError.
 */
export function isNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (
    e instanceof TypeError &&
    (e.message === "fetch failed" || e.message === "terminated")
  )
    return true;
  if (e.name === "AbortError" || e.name === "TimeoutError") return true;
  const code = (e as { code?: unknown }).code;
  const cause = (e as { cause?: { code?: unknown } }).cause?.code;
  return (
    (typeof code === "string" && NET_CODES.has(code)) ||
    (typeof cause === "string" && NET_CODES.has(cause))
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends a request through `send`, which builds a fresh one (and its timeout)
 * each call. A GET or HEAD that throws a network error is sent again after
 * each `backoff` wait; anything else, and any response, goes back at once.
 */
export async function sendRead(
  method: string | undefined,
  send: () => Promise<Response>,
  o: { backoff?: readonly number[]; wait?: (ms: number) => Promise<void> } = {},
): Promise<Response> {
  const m = (method ?? "GET").toUpperCase();
  const backoff =
    m === "GET" || m === "HEAD" ? (o.backoff ?? READ_BACKOFF_MS) : [];
  const wait = o.wait ?? sleep;
  for (let i = 0; ; i++) {
    try {
      return await send();
    } catch (e) {
      const ms = backoff[i];
      if (ms === undefined || !isNetworkError(e)) throw e;
      await wait(ms);
    }
  }
}
