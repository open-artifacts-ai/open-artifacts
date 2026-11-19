import { inDomains } from "@oa/auth-core";
import type { Teammates } from "@oa/shared";
import { authConfig } from "../auth/config.js";
import { isInstanceOwner, TEAM_ROLES } from "../auth/policy.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { personName } from "./users.js";

// #2577: the team's other members for a picker, and "is this address a member".
// Only id, name and initials leave here: never an email.

type Row = {
  id: string;
  role: string;
  status: string;
  email: string;
  name: string | null;
  display_name: string | null;
};

const isTeamRole = (role: string): boolean =>
  (TEAM_ROLES as readonly string[]).includes(role);

/** A team member: active, a team role, and (with login domains set) an address inside them, as isOutsideMember reads it. */
export function isTeammateRow(
  env: Env,
  u: { role: string; status: string; email: string },
): boolean {
  if (u.status !== "active" || !isTeamRole(u.role)) return false;
  const domains = authConfig(env).domains;
  if (domains.length === 0 || isInstanceOwner({ role: u.role as never }))
    return true;
  return inDomains(domains, u.email.slice(u.email.lastIndexOf("@") + 1));
}

/** "Ada Lovelace" -> "AL", "Ada" -> "A": from the shown name, never the email. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

export const TEAMMATES_MAX = 500;

/** The other team members of the instance, by name. Excludes the caller, guests, outsiders and anyone not active. */
export async function listTeammates(
  env: Env,
  callerId: string,
): Promise<Teammates> {
  const { results } = await stmt(
    env.DB,
    `select id, role, status, email, name, display_name from users
     where status = 'active' and role in ('owner', 'admin', 'member') and id <> ?1
     order by lower(coalesce(nullif(trim(display_name), ''), name, '')), id
     limit ?2`,
  )
    .bind(callerId, TEAMMATES_MAX)
    .all<Row>();
  return {
    members: results
      .filter((r) => isTeammateRow(env, r))
      .map((r) => {
        const name = personName({
          email: r.email,
          name: r.name,
          displayName: r.display_name,
        });
        return { id: r.id, name, initials: initialsOf(name) };
      }),
  };
}

/** The user id of the active team member at `email` (lower-cased), else null: outsiders, guests and unknown addresses get none. */
export async function memberIdOfEmail(
  env: Env,
  email: string,
): Promise<string | null> {
  const r = await stmt(
    env.DB,
    "select id, role, status, email from users where email = ?1",
  )
    .bind(email)
    .first<{ id: string; role: string; status: string; email: string }>();
  return r && isTeammateRow(env, r) ? r.id : null;
}
