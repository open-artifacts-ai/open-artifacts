import { normalizeEmail } from "@oa/auth-core";

// ADMIN_IDENTITIES (design v7 4.1, 4.3 step 5): a committed comma list of
// `email:sub`, read on every request. A sign-in matches only when the
// normalized email and the sub both equal one pair exactly; nothing reads
// hd or the email domain.

export type AdminIdentity = { email: string; sub: string };

/** The pairs; a malformed entry admits no one and is skipped. */
export function parseIdentities(raw: string | undefined): AdminIdentity[] {
  const out: AdminIdentity[] = [];
  for (const part of (raw ?? "").split(",")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const email = normalizeEmail(part.slice(0, i));
    const sub = part.slice(i + 1).trim();
    if (email && sub) out.push({ email, sub });
  }
  return out;
}

export type IdentityMatch = "ok" | "unknown_sub" | "not_listed";

/** `email` is already normalized (the verifier's output). */
export function matchIdentity(
  raw: string | undefined,
  email: string,
  sub: string,
): IdentityMatch {
  const list = parseIdentities(raw);
  if (list.some((p) => p.email === email && p.sub === sub)) return "ok";
  return list.some((p) => p.email === email) ? "unknown_sub" : "not_listed";
}

export const isAdminIdentity = (
  raw: string | undefined,
  email: string,
  sub: string,
) => matchIdentity(raw, email, sub) === "ok";
