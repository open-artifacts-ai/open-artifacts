const MAX_CAUSE_DEPTH = 5;

/**
 * Cloudflare's storage failing, not our code: the two forms seen on staging
 * (#1126). Exact on purpose: this answer is retryable (a 503, and a read
 * retry in db/retry.ts), so a bug of ours that merely mentions D1 or KV has
 * to stay a plain `internal`. Its own module so the retry wrapper can use it
 * without importing the HTTP layer (errors.ts imports the OAuth store).
 */
const STORAGE_FAILURE = [
  /^D1_ERROR: internal error\b/,
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
