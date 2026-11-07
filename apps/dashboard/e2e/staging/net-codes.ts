// Which errors mean a request got no HTTP response (#1133, #1596). Public, with
// no imports: T19 (retry.ts) uses it, and the red-line suite re-exports it from
// tests/redline/src/fetch-timeout.ts, so the private side imports the public
// one and never the reverse.

export const NET_CODES = new Set([
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

/** The error code (or name) behind a network error, for reports. */
export function networkCode(e: unknown): string {
  const c = (e as { cause?: { code?: unknown } })?.cause?.code;
  if (typeof c === "string") return c;
  const own = (e as { code?: unknown })?.code;
  if (typeof own === "string") return own;
  return (e as Error)?.name ?? "error";
}

/**
 * True when `e` means the request got no usable response: undici's TypeError
 * "fetch failed" (any cause) or "terminated" (the connection died mid-body),
 * a socket code (ECONNRESET, ...), or an abort/timeout. Never an HTTP status
 * or an assertion.
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

/**
 * The socket code when `e` is a request that got no HTTP response for a
 * transport reason (#1133): a code isNetworkError knows (ECONNRESET,
 * UND_ERR_SOCKET, ...), on the error or its cause. Undefined for an abort or a
 * timeout (ours or a caller's: they have their own handling), a TLS failure
 * or an unknown cause (a bad certificate on our host can be a product bug),
 * and anything that isn't a network error.
 */
export function noResponseCode(e: unknown): string | undefined {
  if (!isNetworkError(e)) return undefined;
  const name = (e as Error).name;
  if (name === "AbortError" || name === "TimeoutError") return undefined;
  const code = networkCode(e);
  return NET_CODES.has(code) ? code : undefined;
}
