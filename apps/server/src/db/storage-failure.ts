const MAX_CAUSE_DEPTH = 5;

/**
 * Cloudflare's storage failing, not our code: the forms seen on staging
 * (#1126). Exact on purpose: this answer is retryable (a 503, and a read
 * retry in db/retry.ts), so a bug of ours that merely mentions D1 or KV has
 * to stay a plain `internal`. Its own module so the retry wrapper can use it
 * without importing the HTTP layer (errors.ts imports the OAuth store).
 */
const STORAGE_FAILURE = [
  /^D1_ERROR: internal error\b/,
  /^D1_ERROR: Network connection lost\b/,
  // R2 binding errors read "<op>: <text> (<code>)": 10001 internal error,
  // 10043 service unavailable (#2218). Never 404s or precondition failures.
  /^(?:get|put|head|list|delete): [^\n]*\((?:10001|10043)\)$/,
  /^(?:get|put|head|list|delete): Network connection lost\b/i,
  /^KV (?:GET|PUT|DELETE|LIST) failed: 5\d\d\b/,
];

export function isStorageFailure(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i <= MAX_CAUSE_DEPTH; i++) {
    if (cur === null || typeof cur !== "object") return false;
    const { message, cause } = cur as { message?: unknown; cause?: unknown };
    if (
      typeof message === "string" &&
      STORAGE_FAILURE.some((re) => re.test(message))
    )
      return true;
    cur = cause;
  }
  return false;
}
