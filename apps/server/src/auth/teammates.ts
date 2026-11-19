import { inDomains } from "@oa/auth-core";
import type { Env } from "../env.js";
import { authConfig } from "./config.js";
import { isInstanceOwner, TEAM_ROLES } from "./policy.js";

/**
 * #2577: a team member, as isOutsideMember reads it: active, a team role,
 * and (with login domains set) an address inside them; the owner is always in.
 */
export function isTeammateRow(
  env: Env,
  u: { role: string; status: string; email: string },
): boolean {
  if (
    u.status !== "active" ||
    !(TEAM_ROLES as readonly string[]).includes(u.role)
  )
    return false;
  const domains = authConfig(env).domains;
  if (domains.length === 0 || isInstanceOwner({ role: u.role as never }))
    return true;
  return inDomains(domains, u.email.slice(u.email.lastIndexOf("@") + 1));
}
