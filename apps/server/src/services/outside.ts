// The owner's switch "Members can share pages with people outside" (#2590).
// A settings row (outside_sharing), unset by default: then on, except on the
// hosted Business tier (off). Read the way billing reads the plan (readPlan):
// self-hosted and any unreadable plan count as on. Off refuses new outside
// shares (putShare) and ends share-made guests' logins, on every path.
import { inDomains } from "@oa/auth-core";
import { authConfig } from "../auth/config.js";
import type { EffectivePlan } from "../billing/plan.js";
import { readPlan } from "../billing/plan.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";

export const OUTSIDE_SHARING_KEY = "outside_sharing";

/** The default with no stored choice: on, except on Business. */
export const outsideDefault = (plan: EffectivePlan | null): boolean =>
  plan?.tier !== "business";

/** The effective switch, from the stored value (if any) and the plan. */
export const outsideFrom = (
  stored: string | undefined,
  plan: EffectivePlan | null,
): boolean =>
  stored === "true" ? true : stored === "false" ? false : outsideDefault(plan);

/** Whether outside sharing is on for this install now. */
export async function outsideSharingOn(env: Env): Promise<boolean> {
  const row = await stmt(env.DB, "select value from settings where key = ?1")
    .bind(OUTSIDE_SHARING_KEY)
    .first<{ value: string }>();
  if (row?.value === "true") return true;
  if (row?.value === "false") return false;
  return outsideDefault(await readPlan(env).catch(() => null));
}

/** An address outside the instance: not in the login domains (with none set, every address). */
export const outsideAddress = (env: Env, email: string): boolean =>
  !inDomains(authConfig(env).domains, email.slice(email.lastIndexOf("@") + 1));

const SHARE_GUEST =
  "select 1 as x from users where id = ?1 and role = 'guest' and invited_at is null";

/**
 * A login refused because the switch is off: a share-made guest (a guest row
 * nobody invited, or no row yet and a share). Invited guests and members are
 * never affected, nor an address in the login domains (not outside).
 * `userId` null: no row.
 */
export async function outsiderLoginOff(
  env: Env,
  userId: string | null,
  email: string,
): Promise<boolean> {
  if (!outsideAddress(env, email)) return false;
  if (
    userId !== null &&
    !(await stmt(env.DB, SHARE_GUEST).bind(userId).first())
  )
    return false;
  return !(await outsideSharingOn(env));
}
