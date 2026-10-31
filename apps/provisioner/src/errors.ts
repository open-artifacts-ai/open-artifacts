// What a Workflow step may say about a failure: a job code (design v7 3.5),
// read from the error's own `code` (provisionErrorCode), never its message,
// and the code's fixed text (JOB_ERROR_TEXT). Never an error's own text: a
// refusal's message can echo request values (a slug, a key name) and a
// Cloudflare or D1 message can quote input.
import { NonRetryableError } from "cloudflare:workflows";
import {
  PROVISION_ERROR_CODES,
  type ProvisionErrorCode,
  ProvisionRetry,
  provisionErrorCode,
} from "@oa/provision";

/** jobs.error_message is at most 300 characters (0008). */
export const ERROR_MESSAGE_MAX = 300;

/**
 * A ProvisionRetry (a held lease, a pending revoke, a token not active), a
 * Cloudflare error and anything unclassified retry: create is check-first
 * and leased, so a rerun resumes it. Every other refusal is terminal.
 */
export function classify(e: unknown): {
  retryable: boolean;
  code: ProvisionErrorCode;
} {
  const code = provisionErrorCode(e);
  const retryable =
    e instanceof ProvisionRetry || code === "cf_error" || code === "internal";
  return { retryable, code };
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` without `email` in any case, raw or URL-encoded. */
export function redactEmail(text: string, email: string): string {
  const e = email.trim();
  if (!e) return text;
  let out = text;
  for (const form of new Set([e, encodeURIComponent(e)]))
    out = out.replace(new RegExp(reEscape(form), "gi"), "[email]");
  return out;
}

/** The failure log line's detail cap, in characters. */
export const LOG_DETAIL_MAX = 200;

/**
 * `text` for the Worker's own log: every request value in `values` (raw or
 * URL-encoded, any case, longest first), then any email, URL or IP address,
 * replaced by a placeholder; at most LOG_DETAIL_MAX characters.
 */
export function redactDetail(text: string, values: readonly string[]): string {
  let out = text;
  const forms = new Set<string>();
  for (const v of values) {
    const t = v.trim();
    if (!t) continue;
    forms.add(t);
    forms.add(encodeURIComponent(t));
  }
  for (const f of [...forms].sort((a, b) => b.length - a.length))
    out = out.replace(new RegExp(reEscape(f), "gi"), "[value]");
  out = out
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/[^\s@"'<>()]+(?:@|%40)[^\s@"'<>()]+/gi, "[email]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]")
    // IPv6 (and anything with two or more hex:colon groups).
    .replace(/(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}/gi, "[ip]");
  return out.slice(0, LOG_DETAIL_MAX);
}

/**
 * jobs.error_message per job code: a short, neutral sentence, never
 * interpolated, so a stored message carries no request value or inner
 * error text.
 */
export const JOB_ERROR_TEXT = Object.freeze({
  release_not_published: "The requested release is not published.",
  release_unverified: "The release could not be verified.",
  downgrade_refused: "A downgrade to an older release is refused.",
  prod_dirty: "The install failed its clean-state check.",
  invalid_state: "The install is not in a state that allows this job.",
  slug_taken: "The requested name is already taken.",
  lease_held: "Another job holds the install's lease.",
  revoke_pending: "A token revoke is still pending.",
  token_invalid: "The Cloudflare token is not active.",
  upgrade_rolled_back: "The upgrade failed and was rolled back.",
  upgrade_incomplete: "The upgrade did not complete.",
  canceled: "The job was canceled.",
  run_dead: "The job's Workflow run stopped.",
  cf_error: "A Cloudflare API call failed.",
  internal: "An internal error occurred.",
} as const satisfies Record<ProvisionErrorCode, string>);

/**
 * The error a step throws for `e`: `new Error(code)`, as a
 * NonRetryableError unless the code is retryable; a terminal one adds
 * ": <JOB_ERROR_TEXT>". Never the refusal's own message.
 */
export function stepError(e: unknown): Error {
  const { retryable, code } = classify(e);
  if (retryable) return new Error(code);
  return new NonRetryableError(`${code}: ${JOB_ERROR_TEXT[code]}`);
}

/** An error's own text, for the redacted log line only. */
export function detailOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** The code a step's error carries (its text up to the first ":"). */
export function codeOf(e: unknown): ProvisionErrorCode {
  const head = String((e as Error | null)?.message ?? "").split(":")[0];
  return (PROVISION_ERROR_CODES as readonly string[]).includes(head as string)
    ? (head as ProvisionErrorCode)
    : "internal";
}
