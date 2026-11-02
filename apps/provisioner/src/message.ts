import { ULID_RE } from "@oa/shared/provisioning";

/**
 * One `oa-<p>-signups` message: the signup id only. The API writes the
 * `signups` row (pending), its `signup_secret` row and its create job before
 * it enqueues, so the email, slug and sub never enter a queue (or its DLQ).
 * The Workflow's params are `WorkflowParams` (`{ jobId }`, design v7 3.6).
 */
export interface SignupMessage {
  /** A ULID minted by the API when the sign-up is accepted. */
  signupId: string;
}

/** The message, or null for any other shape (an extra key included). */
export function parseSignup(body: unknown): SignupMessage | null {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return null;
  const keys = Object.keys(body);
  const { signupId } = body as Record<string, unknown>;
  return keys.length === 1 &&
    keys[0] === "signupId" &&
    typeof signupId === "string" &&
    ULID_RE.test(signupId)
    ? { signupId }
    : null;
}

/** The signup id of a body when it has a well-formed one, else null. */
export function signupIdOf(body: unknown): string | null {
  const id =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).signupId
      : undefined;
  return typeof id === "string" && ULID_RE.test(id) ? id : null;
}
