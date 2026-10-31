// Provisioning error codes (design v7 3.5) as plain constants: no zod, so
// the scheduler imports them through `@oa/shared/provisioning/errors`.
// errors.ts builds the schemas from these and re-exports them.

/** ApiErrorCode -> its one HTTP status (design v7 3.5). */
export const API_ERROR_STATUS = {
  unauthenticated: 401,
  forbidden: 403,
  reauth_required: 403,
  csrf_failed: 403,
  not_found: 404,
  rate_limited: 429,
  invalid_input: 400,
  payload_too_large: 413,
  unsupported_media_type: 415,
  confirm_mismatch: 400,
  slug_invalid: 400,
  slug_reserved: 400,
  slug_taken: 409,
  idempotency_conflict: 409,
  /** Checked before invalid_state; details.jobId. */
  job_in_progress: 409,
  invalid_state: 409,
  grace_expired: 409,
  downgrade_refused: 409,
  signup_limit: 409,
  token_limit: 409,
  release_not_published: 422,
  turnstile_failed: 403,
  signups_closed: 503,
  /** A rate-limit binding unbound (fail closed), a binding or table missing. */
  unavailable: 503,
  /** Never Cloudflare text. */
  internal: 500,
} as const;
export type ApiErrorCode = keyof typeof API_ERROR_STATUS;
export const API_ERROR_CODES = Object.keys(API_ERROR_STATUS) as [
  ApiErrorCode,
  ...ApiErrorCode[],
];

/**
 * JobErrorCode (jobs.error_code, no HTTP status) -> retry class: "retry"
 * (bounded where 3.5 says so), "terminal", or "terminal_alert" (terminal and
 * opens an alert).
 */
export const JOB_ERROR_RETRY = {
  release_not_published: "terminal",
  release_unverified: "terminal",
  downgrade_refused: "terminal",
  prod_dirty: "terminal",
  invalid_state: "terminal",
  slug_taken: "terminal",
  lease_held: "retry",
  revoke_pending: "retry",
  /** Every 15 min, up to 2 h. */
  token_invalid: "retry",
  upgrade_rolled_back: "terminal",
  upgrade_incomplete: "terminal_alert",
  canceled: "terminal",
  cf_error: "retry",
  internal: "retry",
} as const satisfies Record<string, "retry" | "terminal" | "terminal_alert">;
export type JobErrorCode = keyof typeof JOB_ERROR_RETRY;
export const JOB_ERROR_CODES = Object.keys(JOB_ERROR_RETRY) as [
  JobErrorCode,
  ...JobErrorCode[],
];
