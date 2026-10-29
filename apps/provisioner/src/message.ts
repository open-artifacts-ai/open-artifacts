/**
 * One `oa-<p>-signups` message: the signup id only. SS4 writes the `signups`
 * row (pending) and its `signup_secret` row before it enqueues, so the email,
 * slug and sub never enter a queue (or its DLQ).
 */
export interface SignupMessage {
  /** A ULID minted by SS4 when the sign-up is accepted. */
  signupId: string;
}

/** The Workflow's params, read from the stored row. */
export interface ProvisionParams {
  signupId: string;
  slug: string;
  ownerSub: string;
}

/** Crockford base32, 26 characters, a 48-bit time (first character 0-7). */
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

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
