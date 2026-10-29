import { isValidSlug } from "@oa/provision/names";

/**
 * One `oa-<p>-signups` message, as SS4 enqueues it. `ownerEmail` lives only
 * here and in `signup_secret`: never in a log line, Workflow param, DLQ
 * payload or any other D1 row.
 */
export interface SignupMessage {
  /** A ULID minted by SS4 when the sign-up is accepted. */
  signupId: string;
  slug: string;
  /** The Google subject. */
  ownerSub: string;
  ownerEmail: string;
  tier: "free";
}

/** The Workflow's params: the message without the email. */
export interface ProvisionParams {
  signupId: string;
  slug: string;
  ownerSub: string;
}

/** Crockford base32, 26 characters, a 48-bit time (first character 0-7). */
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const SUB_RE = /^[0-9]{1,255}$/;
// A plausible address only: Email Sending rejects what this lets through.
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const KEYS = ["ownerEmail", "ownerSub", "signupId", "slug", "tier"];

/** The message, or null for any other shape (an extra key included). */
export function parseSignup(body: unknown): SignupMessage | null {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return null;
  const b = body as Record<string, unknown>;
  if (Object.keys(b).sort().join() !== KEYS.join()) return null;
  const { signupId, slug, ownerSub, ownerEmail, tier } = b;
  if (
    typeof signupId !== "string" ||
    !ULID_RE.test(signupId) ||
    !isValidSlug(slug) ||
    typeof ownerSub !== "string" ||
    !SUB_RE.test(ownerSub) ||
    typeof ownerEmail !== "string" ||
    ownerEmail.length > 254 ||
    !EMAIL_RE.test(ownerEmail) ||
    tier !== "free"
  )
    return null;
  return { signupId, slug, ownerSub, ownerEmail, tier };
}

/** The signup id of a body when it has a well-formed one, else null. */
export function signupIdOf(body: unknown): string | null {
  const id =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).signupId
      : undefined;
  return typeof id === "string" && ULID_RE.test(id) ? id : null;
}
