// Provisioning error codes (design v7 3.5) as plain constants: no zod, so
// the scheduler imports them through `@oa/provisioning-contract/error-codes`.
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
  /** A create's or upgrade's explicit version is newer than the platform's own release (#1176). */
  release_ahead_of_platform: 409,
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
  /**
   * A dead Workflow run (errored, terminated, or complete with the job
   * open), settled by the scheduler sweep; never retried. job_failed alerts
   * and the sweep's cleanup job runs (Manager C5).
   */
  run_dead: "terminal",
  domain_codes_refused: "terminal",
  migration_held: "terminal",
  restore_point_failed: "terminal",
  /** #1343: the target binds a new DO class; the install takes a release first. */
  do_step_required: "terminal",
  turnstile_missing: "terminal",
  /** #1008: /healthz never showed the mode asked for. */
  mode_not_live: "terminal",
  /** Leaving d1, which only a person's separate override may do. */
  leave_d1_refused: "terminal",
  /** No complete copy: d1 asked for without one, or a copy that didn't end. */
  copy_incomplete: "terminal",
  copy_not_dual: "terminal",
  copy_markers: "terminal",
  /** The fresh OAUTH_COPY_KEY never went live on the install. */
  copy_key_not_live: "terminal",
  /** OAUTH_COPY_KEY is still on the script; job_failed alerts. */
  copy_key_left: "terminal",
  cf_error: "retry",
  internal: "retry",
} as const satisfies Record<string, "retry" | "terminal" | "terminal_alert">;
export type JobErrorCode = keyof typeof JOB_ERROR_RETRY;
export const JOB_ERROR_CODES = Object.keys(JOB_ERROR_RETRY) as [
  JobErrorCode,
  ...JobErrorCode[],
];
