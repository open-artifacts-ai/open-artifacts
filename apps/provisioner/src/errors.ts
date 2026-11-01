// What a Workflow step may say about a failure: a job code (design v7 3.5),
// read from the error's own `code` (provisionErrorCode), never its message,
// and the code's fixed text (JOB_ERROR_TEXT). Never an error's own text: a
// refusal's message can echo request values (a slug, a key name) and a
// Cloudflare or D1 message can quote input.
import { NonRetryableError } from "cloudflare:workflows";
import {
  CfError,
  PROVISION_ERROR_CODES,
  type ProvisionErrorCode,
  ProvisionRetry,
  provisionErrorCode,
} from "@oa/provision";
import { TEST_HOOK_REFUSALS, type TestHookRefusal } from "@oa/shared";
import { JOB_FAIL_POINTS, type JobFailPoint } from "@oa/shared/provisioning";

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
 * A terminal refusal raised inside the provisioner (a recheck): its message
 * is exactly `<code>: <JOB_ERROR_TEXT>`, so the Workflow engine's instance
 * error holds no detail; `detail` goes only to the redacted log line.
 */
export class StepRefusal extends NonRetryableError {
  readonly detail: string;
  constructor(code: ProvisionErrorCode, detail: string) {
    super(`${code}: ${JOB_ERROR_TEXT[code]}`);
    this.detail = detail;
  }
}

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
  if (e instanceof StepRefusal) return e.detail;
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

/**
 * #995: where an attempt failed, on the error itself (a symbol, never its
 * message): a fixed JOB_FAIL_POINTS point, the failing call's HTTP status
 * and a test hook's TEST_HOOK_REFUSALS reason. noteFailure writes it to
 * jobs.fail_at, fail_status and fail_reason; anything outside those sets is
 * null.
 */
export type FailAt = {
  at: JobFailPoint;
  status: number | null;
  reason: TestHookRefusal | null;
};
const FAIL_AT = Symbol.for("oa.provisioner.failAt");

/** `e` tagged with its fail point (the first tag wins); `e` itself. */
export function tagFail<E>(
  e: E,
  at: JobFailPoint,
  status: number | null = null,
  reason: TestHookRefusal | null = null,
): E {
  if (e !== null && typeof e === "object" && !(FAIL_AT in e)) {
    const s = status ?? (e instanceof CfError ? e.status : null);
    Object.defineProperty(e, FAIL_AT, {
      value: Object.freeze({ at, status: s, reason }),
    });
  }
  return e;
}

/** The fail point an error carries, each part checked against its set. */
export function failOf(e: unknown): FailAt | null {
  if (e === null || typeof e !== "object") return null;
  const f = (e as Record<symbol, unknown>)[FAIL_AT] as
    | Partial<FailAt>
    | undefined;
  if (!f || !(JOB_FAIL_POINTS as readonly string[]).includes(f.at as string))
    return null;
  const s = f.status;
  return {
    at: f.at as JobFailPoint,
    status:
      typeof s === "number" && Number.isInteger(s) && s >= 100 && s <= 599
        ? s
        : null,
    reason: (TEST_HOOK_REFUSALS as readonly string[]).includes(
      f.reason as string,
    )
      ? (f.reason as TestHookRefusal)
      : null,
  };
}

/** `fn`, with any error it throws tagged at `at`. */
export async function failingAt<T>(
  at: JobFailPoint,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw tagFail(e, at);
  }
}
