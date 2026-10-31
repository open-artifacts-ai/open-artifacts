import type { AuditEntry } from "@oa/shared/provisioning";
import type { Principal } from "../principal.js";

// The R17 email rule (design v7 4.2, 4.9): a token principal without
// `installs:pii` gets every email-valued `detail` field as null, on /v1 and
// /mcp alike. By value, not by key, so rows that carry an email under a key
// nobody listed (post-M1 owner emails, 14.4) are covered too. W4's R17
// handler maps each merged entry through redactAuditEntry.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isEmailValue = (v: unknown): boolean =>
  typeof v === "string" && EMAIL_RE.test(v.trim());

export const mayReadPii = (p: Principal) =>
  p.kind !== "token" || p.scopes.includes("installs:pii");

function redact(v: unknown): unknown {
  if (isEmailValue(v)) return null;
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

export function redactAuditEntry(
  e: AuditEntry,
  principal: Principal,
): AuditEntry {
  if (mayReadPii(principal) || e.detail === null) return e;
  return { ...e, detail: redact(e.detail) as AuditEntry["detail"] };
}
