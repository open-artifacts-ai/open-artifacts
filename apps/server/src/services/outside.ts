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
import { addressHash } from "../email/share-optout.js";
import type { Env } from "../env.js";
import { type AuditActor, audit } from "./audit.js";

/**
 * Takes an address off this install's "Don't email me again" list (#2653), by
 * the hash of its normalized form, so outside share emails can reach it again.
 * One batch: the settings.change audit row (the hash only, never the address;
 * written only when a row is there) and the delete. This install's list only:
 * a hosted-wide opt-out lives on the platform and isn't touched. Resolves to
 * whether a row was removed; null for something that isn't an address.
 */
export async function removeOutsideOptout(
  env: Env,
  email: string,
  by: AuditActor,
): Promise<boolean | null> {
  const hash = await addressHash(email);
  if (!hash) return null;
  const [, del] = await env.DB.batch([
    audit(env, "settings.change", { type: "settings", id: "instance" }, by, {
      detail: { removedOptout: hash },
      when: {
        sql: "exists (select 1 from email_optouts where address_hash = ?)",
        args: [hash],
      },
    }),
    stmt(env.DB, "delete from email_optouts where address_hash = ?1").bind(
      hash,
    ),
  ]);
  return (del?.meta.changes ?? 0) > 0;
}

export const OUTSIDE_SHARING_KEY = "outside_sharing";

/** The default with no stored choice: on, except on Business. */
export const outsideDefault = (plan: EffectivePlan | null): boolean =>
  plan?.tier !== "business";

/**
 * Whether outside sharing is on, as a stored fact (#2590): the first read with
 * nothing stored writes the plan's default once (on, but off on hosted
 * Business), with a settings.change audit row, actor system, in the same
 * batch (on when any outside share already exists). After that it is never
 * derived from the plan again, so moving to another tier changes nothing until
 * the owner does. The page and every
 * enforcement read this same value. An unreadable plan writes nothing (on
 * for now) so a billing outage can't fix a wrong default.
 */
export async function outsideSharingOn(env: Env): Promise<boolean> {
  const read = () =>
    stmt(env.DB, "select value from settings where key = ?1")
      .bind(OUTSIDE_SHARING_KEY)
      .first<{ value: string }>();
  const stored = await read();
  if (stored) return stored.value === "true";
  let plan: EffectivePlan | null;
  try {
    plan = await readPlan(env);
  } catch {
    return true;
  }
  // An instance that already shares outside keeps doing so: with any share to
  // an outside address on record, the first stored value is on, whatever the
  // plan's default (turning it off is the owner's call).
  const on =
    outsideDefault(plan) ||
    (await stmt(
      env.DB,
      `select 1 as x from shares
        where lower(substr(email, instr(email, '@') + 1)) not in (select value from json_each(?1)) limit 1`,
    )
      .bind(JSON.stringify(authConfig(env).domains))
      .first()) !== null;
  await env.DB.batch([
    audit(
      env,
      "settings.change",
      { type: "settings", id: "instance" },
      { kind: "system", id: null },
      {
        detail: { changes: { outsideSharing: { from: null, to: on } } },
        when: {
          sql: "not exists (select 1 from settings where key = ?)",
          args: [OUTSIDE_SHARING_KEY],
        },
      },
    ),
    stmt(
      env.DB,
      "insert into settings (key, value) values (?1, ?2) on conflict (key) do nothing",
    ).bind(OUTSIDE_SHARING_KEY, String(on)),
  ]);
  // A concurrent first read may have written the other way round: what is
  // stored now is the fact.
  return (await read())?.value === "true";
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
