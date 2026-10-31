import type { Env } from "../env.js";

// ADMIN_IDENTITIES (design v7 4.1): the committed `email:sub` comma list,
// read on every request, so removing a pair ends that admin's sessions and
// tokens on the next call. Email compares case-insensitively; sub exactly.

export function adminIdentities(
  env: Pick<Env, "ADMIN_IDENTITIES">,
): { email: string; sub: string }[] {
  return env.ADMIN_IDENTITIES.split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => {
      const i = p.lastIndexOf(":");
      if (i <= 0 || i === p.length - 1) return [];
      return [{ email: p.slice(0, i).toLowerCase(), sub: p.slice(i + 1) }];
    });
}

export const isAdminIdentity = (
  env: Pick<Env, "ADMIN_IDENTITIES">,
  email: string,
  sub: string,
) =>
  adminIdentities(env).some(
    (a) => a.email === email.toLowerCase() && a.sub === sub,
  );
