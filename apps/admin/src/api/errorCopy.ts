import { ApiError } from "./client";

/** Plain copy per API error code (design 3.5) and job error code. */
const COPY: Record<string, string> = {
  unauthenticated: "Your session ended. Sign in again.",
  forbidden: "You are not allowed to do that.",
  reauth_required: "Sign in again to confirm this.",
  csrf_failed: "Your session changed. Reload the page and try again.",
  not_found: "That no longer exists.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  invalid_input: "Some of that input is not valid.",
  payload_too_large: "That request is too large.",
  unsupported_media_type: "The server did not accept that request.",
  confirm_mismatch: "The text you typed does not match.",
  slug_invalid:
    "Use 1 to 32 lowercase letters, digits or hyphens, starting and ending with a letter or digit. Hyphens cannot be 3rd and 4th.",
  slug_reserved: "That name is reserved.",
  slug_taken: "That name is taken.",
  idempotency_conflict:
    "That request was already used for something else. Reload and try again.",
  job_in_progress: "Another job is already running on this install.",
  invalid_state: "That is not possible in the install's current state.",
  grace_expired: "The restore window has passed.",
  downgrade_refused:
    "That version is older than the one installed. Use rollback to go back one version.",
  signup_limit: "The sign-up limit is reached.",
  token_limit: "There are too many tokens. Revoke one first.",
  release_not_published: "That release is not published.",
  turnstile_failed: "The bot check failed.",
  signups_closed: "Sign-ups are closed.",
  unavailable: "The service is not available right now. Try again soon.",
  internal: "Something went wrong on our side. Try again.",
  // Job error codes.
  release_unverified: "The release could not be verified.",
  prod_dirty: "The production check found leftovers. Nothing was changed.",
  lease_held: "Another job holds the install's lease. It will retry.",
  revoke_pending: "Directory access is still being revoked. It will retry.",
  token_invalid: "The provisioning token is invalid. It will retry.",
  upgrade_rolled_back: "The upgrade failed and was rolled back.",
  upgrade_incomplete: "The upgrade did not finish. Check the install.",
  canceled: "The job was canceled.",
  cf_error: "Cloudflare returned an error. It will retry.",
};

export const codeCopy = (code: string | null | undefined): string | null =>
  code && Object.hasOwn(COPY, code) ? COPY[code] : null;

/** What to show for a failed call. */
export function errorCopy(e: unknown): string {
  if (e instanceof ApiError)
    return codeCopy(e.code) ?? `The server answered ${e.status}.`;
  return "Check your connection and try again.";
}
