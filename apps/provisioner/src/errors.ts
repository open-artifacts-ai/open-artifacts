// What a Workflow step may say about a failure: a job code (design v7 3.5),
// read from the error's own `code` (provisionErrorCode), never its message,
// and only for a terminal refusal that refusal's message (create has already
// scrubbed its own secrets from it; the owner's email is scrubbed again
// here), capped like jobs.error_message. Never an error's own text otherwise:
// a Cloudflare or D1 message could quote input.
import { NonRetryableError } from "cloudflare:workflows";
import {
  PROVISION_ERROR_CODES,
  type ProvisionErrorCode,
  ProvisionRefused,
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

/**
 * The error a step throws for `e`: `new Error(code)`, with ": <message>" for
 * a terminal refusal, as a NonRetryableError unless the code is retryable.
 */
export function stepError(e: unknown, email: string | null): Error {
  const { retryable, code } = classify(e);
  if (retryable) return new Error(code);
  let text: string = code;
  if (e instanceof ProvisionRefused) {
    const m = email ? redactEmail(e.message, email) : e.message;
    text = `${code}: ${m}`.slice(0, ERROR_MESSAGE_MAX);
  }
  return new NonRetryableError(text);
}

/** The code a step's error carries (its text up to the first ":"). */
export function codeOf(e: unknown): ProvisionErrorCode {
  const head = String((e as Error | null)?.message ?? "").split(":")[0];
  return (PROVISION_ERROR_CODES as readonly string[]).includes(head as string)
    ? (head as ProvisionErrorCode)
    : "internal";
}
