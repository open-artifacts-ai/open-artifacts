// What a Workflow step may say about a failure: a fixed category, and only
// for `refused` the ProvisionRefused message (create has already scrubbed its
// own secrets from it; the signup's email is scrubbed again here). Never an
// error's own text otherwise: a Cloudflare or D1 message could quote input.
import { NonRetryableError } from "cloudflare:workflows";
import { CfError, ProvisionRefused } from "@oa/provision";

export type Category =
  | "lease_held"
  | "slug_taken"
  | "refused"
  | "cf_error"
  | "internal";

const CATEGORIES: readonly Category[] = [
  "lease_held",
  "slug_taken",
  "refused",
  "cf_error",
  "internal",
];

/** create's claim refusal while another run holds the install's lease. */
const LEASE_HELD = /is busy: another operation holds it/;
/** The slug, or a host derived from it, belongs to another install. */
const SLUG_TAKEN =
  /slug \S+ already exists as active install|slug \S+ is already taken by install|host \S+ is already taken by|host or broker origin already taken by install/;

export function classify(e: unknown): {
  retryable: boolean;
  category: Category;
} {
  if (e instanceof ProvisionRefused) {
    if (LEASE_HELD.test(e.message))
      return { retryable: true, category: "lease_held" };
    if (SLUG_TAKEN.test(e.message))
      return { retryable: false, category: "slug_taken" };
    return { retryable: false, category: "refused" };
  }
  if (e instanceof CfError) return { retryable: true, category: "cf_error" };
  // Any other error (a /healthz timeout, an MCP selftest failure, "rerun to
  // resume"): create is check-first and leased, so a retry resumes it.
  return { retryable: true, category: "internal" };
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
 * The error a step throws for `e`: `new Error(category)`, with ": <message>"
 * for `refused`, as a NonRetryableError unless the category is retryable.
 */
export function stepError(e: unknown, email: string | null): Error {
  const { retryable, category } = classify(e);
  let text: string = category;
  if (category === "refused") {
    const m = (e as Error).message;
    text = `${category}: ${email ? redactEmail(m, email) : m}`;
  }
  return retryable ? new Error(text) : new NonRetryableError(text);
}

/** The category a step's error carries (its text up to the first ":"). */
export function categoryOf(e: unknown): Category {
  const head = String((e as Error | null)?.message ?? "").split(":")[0];
  return (CATEGORIES as readonly string[]).includes(head as string)
    ? (head as Category)
    : "internal";
}
