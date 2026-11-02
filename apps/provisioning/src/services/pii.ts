import type { AuditEntry } from "@oa/shared/provisioning";
import type { Principal } from "../principal.js";

// The R17 email rule (design v7 4.2, 4.9): a token principal without
// `installs:pii` gets every email-valued `detail` field as null (`admin`
// only on rows of another admin), on /v1 and /mcp alike. By value, not by key, so rows that carry an email under a key
// nobody listed (post-M1 owner emails, 14.4) are covered too. W4's R17
// handler maps each merged entry through redactAuditEntry. A string that
// holds an email among other text (`name <a@b.c>`, an error message, an
// `args` note) is hidden whole too.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HAS_EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

export const isEmailValue = (v: unknown): boolean =>
  typeof v === "string" && EMAIL_RE.test(v.trim());

/** True for a string with an email anywhere in it (what redaction hides). */
export const hasEmail = (v: unknown): boolean =>
  typeof v === "string" && HAS_EMAIL_RE.test(v);

export const mayReadPii = (p: Principal) =>
  p.kind !== "token" || p.scopes.includes("installs:pii");

/** What a hidden email actor label reads as (the label column is NOT NULL). */
export const REDACTED_LABEL = "hidden";

const sameEmail = (a: unknown, b: string | undefined) =>
  typeof a === "string" &&
  b !== undefined &&
  a.trim().toLowerCase() === b.trim().toLowerCase();

function redact(v: unknown): unknown {
  if (hasEmail(v)) return null;
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        k,
        redact(x),
      ]),
    );
  return v;
}

/**
 * Also hides an email-valued `actor.label` (admin and self-serve rows). The
 * caller's own admin is not "another admin" (9A.8): its `detail.admin` and
 * actor label stay.
 */
export function redactAuditEntry(
  e: AuditEntry,
  principal: Principal,
): AuditEntry {
  if (mayReadPii(principal)) return e;
  const own = principal.email;
  let out = e;
  if (hasEmail(e.actor.label) && !sameEmail(e.actor.label, own))
    out = { ...out, actor: { ...e.actor, label: REDACTED_LABEL } };
  if (e.detail !== null) {
    const { admin, ...rest } = e.detail;
    const detail = redact(rest) as Record<string, unknown>;
    if ("admin" in e.detail)
      detail.admin = sameEmail(admin, own) ? admin : redact(admin);
    out = { ...out, detail };
  }
  return out;
}
