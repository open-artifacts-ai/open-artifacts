import { inDomains, normalizeEmail } from "@oa/auth-core";
import type { Member, Role } from "@oa/shared";
import { logAuth } from "../auth/audit.js";
import { callerOf, capOfCaller, managesAdmins } from "../auth/authz.js";
import type { AuthConfig } from "../auth/config.js";
import { isGuestRole, orgCan } from "../auth/policy.js";
import type { VerifiedIdentity } from "../auth/providers/types.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { revokeAllGrants } from "../mcp/oauth-api.js";
import { revokeUserLive } from "../runtime/revoke.js";
import { audit, signInAudit, userActor } from "./audit.js";
import { moveUserEmail } from "./email-move.js";
import { googleLinkStmts, toMember } from "./users.js";

// Admission and account linking for direct sign-in (P2). identities
// (provider, subject) is the only link; email links an existing ACTIVE row at
// most once, never a removed or suspended one.

export type AdmitResult =
  | { ok: true; user: Member }
  | {
      ok: false;
      reason: "tenant" | "identity_conflict" | "removed" | "no_access";
    };

type UserRow = {
  id: string;
  email: string;
  name: string;
  displayName: string | null;
  role: string;
  lastSeenAt: number | null;
  status: string;
};

const USER_COLS =
  "u.id, u.email, u.name, u.display_name as displayName, u.role, u.last_seen_at as lastSeenAt, u.status";

const BY_SUBJECT = `select ${USER_COLS} from identities i join users u on u.id = i.user_id
  where i.provider = ?1 and i.subject = ?2 limit 1`;
const BY_EMAIL = `select ${USER_COLS}, (select subject from identities i where i.user_id = u.id and i.provider = 'google') as subject
  from users u where u.email = ?1 limit 1`;

const AN_OWNER = "select 1 as x from users where role = 'owner' limit 1";

const member = (r: UserRow) => toMember(r as Parameters<typeof toMember>[0]);

const logDrift = () => logAuth({ evt: "email_drift", outcome: "kept" });

/**
 * Name, last-seen, guest promotion (hd verified) and owner role on sign-in.
 * A personal account (no hd) proves no domain membership: a guest stays a
 * guest.
 */
async function touch(
  env: Env,
  row: UserRow,
  id: VerifiedIdentity,
  now: number,
): Promise<Member | null> {
  const promote = id.tenant ? 1 : 0;
  const owner = normalizeEmail(env.OWNER_EMAIL ?? "");
  // The role is promoted from the row's CURRENT role, in SQL (promotedRole:
  // guest becomes member, every other role is kept), never written back from
  // the read above: an admin demotion racing this sign-in sticks (P3 T6).
  // OWNER_EMAIL becomes owner only while no owner row exists (one owner).
  // An active row only: a user who stopped being active mid-sign-in matches
  // no row, gets no auth.signin row, and is refused (null). The admission
  // and its audit row commit together.
  const [res] = await env.DB.batch<UserRow>([
    stmt(
      env.DB,
      `update users set last_seen_at = ?1, name = coalesce(?2, name),
         role = case when ?4 = 1 and not exists (select 1 from users where role = 'owner') then 'owner'
                     when role = 'guest' and ?5 = 1 then 'member' else role end
       where id = ?3 and status = 'active'
       returning id, email, name, display_name as displayName, role, last_seen_at as lastSeenAt, status`,
    ).bind(now, id.name, row.id, owner && row.email === owner ? 1 : 0, promote),
    signInAudit(env, row.id, id.provider, id.tenant, {
      sql: "changes() > 0",
      args: [],
    }),
  ]);
  const out = res?.results[0];
  return out ? member(out) : null;
}

/**
 * Moves a linked user to their new verified address when nobody else has it,
 * with their shares (moveUserEmail: a freed address inherits nothing).
 */
async function followDrift(
  env: Env,
  row: UserRow,
  email: string,
): Promise<UserRow> {
  if (email === row.email) return row;
  // Never onto OWNER_EMAIL: drift must not hand anyone the owner address
  // (moveUserEmail refuses it too).
  try {
    const out = await moveUserEmail(env, row.id, row.email, email);
    if (out) return out;
  } catch {
    // A concurrent insert took the address: keep the old one.
  }
  logDrift();
  return row;
}

/**
 * Admits a verified Google identity. No hd (a personal account): see
 * admitPersonal. Otherwise:
 * 1. The tenant (hd) must still be a verified domain.
 * 2. Linked (provider, subject): that user, unless not active (removed);
 *    follow email drift when the new address is free.
 * 3. Unlinked: an existing row with the email must be active (else removed)
 *    and have no other Google link (else identity_conflict); a new row needs
 *    join = member or OWNER_EMAIL (else no_access). Created and linked in one
 *    race-safe batch (googleLinkStmts).
 * A guest promoted to member here is safe: hd proves domain membership.
 */
export async function admit(
  env: Env,
  cfg: AuthConfig,
  id: VerifiedIdentity,
  now = Date.now(),
): Promise<AdmitResult> {
  if (id.provider === "google" && id.tenant === null)
    return admitPersonal(env, cfg, id, now);
  if (!googleTenantOk(cfg, id.tenant)) return { ok: false, reason: "tenant" };
  const email = normalizeEmail(id.email);
  if (!email) return { ok: false, reason: "no_access" };

  const linked = await stmt(env.DB, BY_SUBJECT)
    .bind(id.provider, id.subject)
    .first<UserRow>();
  if (linked) {
    if (linked.status !== "active") return { ok: false, reason: "removed" };
    return admitted(
      await touch(env, await followDrift(env, linked, email), id, now),
    );
  }

  const existing = await stmt(env.DB, BY_EMAIL)
    .bind(email)
    .first<UserRow & { subject: string | null }>();
  if (existing && existing.status !== "active")
    return { ok: false, reason: "removed" };
  if (existing?.subject) return conflict(env, existing.id, now);
  // OWNER_EMAIL is special only while no owner exists; then normal join rules.
  const isOwner =
    email === normalizeEmail(env.OWNER_EMAIL ?? "") &&
    !(await stmt(env.DB, AN_OWNER).first());
  if (!existing && !googleNewRowOk(cfg, isOwner))
    return { ok: false, reason: "no_access" };

  const results = await env.DB.batch<UserRow & { subject: string | null }>(
    googleLinkStmts(env, {
      email,
      name: id.name,
      role: isOwner ? "owner" : "member",
      subject: id.subject,
      tenant: id.tenant as string,
      now,
    }),
  );
  const row = results[2]?.results[0];
  if (!row) return { ok: false, reason: "no_access" };
  if (row.status !== "active") return { ok: false, reason: "removed" };
  if (row.subject !== id.subject) return conflict(env, row.id, now);
  return admitted(await touch(env, row, id, now));
}

/** identities.tenant of a personal Google account (no hd): never a domain. */
export const PERSONAL_TENANT = "";

const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);

/**
 * Links a personal account to the existing row ?2 (id) at ?3 (email): never
 * inserts a user, only an identity, and only onto that same active row with
 * no Google identity yet. The select after it reads what the link left.
 */
const PERSONAL_LINK = `insert into identities (provider, subject, tenant, user_id, created_at)
  select 'google', ?1, '${PERSONAL_TENANT}', u.id, ?4 from users u
  where u.id = ?2 and u.email = ?3 and u.status = 'active'
    and not exists (select 1 from identities i where i.provider = 'google' and i.user_id = u.id)
  on conflict do nothing`;
const PERSONAL_ROW = `select ${USER_COLS},
    (select subject from identities i where i.user_id = u.id and i.provider = 'google') as subject
  from users u where u.id = ?1 and u.email = ?2`;
const PERSONAL_RELINKED = `update users set google_relink = 0 where id = ?1 and google_relink = 1
  and exists (select 1 from identities i where i.provider = 'google' and i.user_id = users.id)`;

/**
 * A personal Google account (verified email, no hd). Admitted only when all
 * of these hold, and never creates a user:
 * - the email's domain is not one of AUTH_DOMAINS (those sign in through
 *   Workspace): else tenant;
 * - the email is exactly an existing row here (an invite or a member; BY_EMAIL)
 *   that is active (never a removed or lapsed guest): else no_access or removed;
 * - the subject pin: a row linked to another Google account is refused
 *   (identity_conflict, flagged to the owner); the first sign-in pins `sub`.
 * The email is the row's: no drift is followed for a personal account.
 */
async function admitPersonal(
  env: Env,
  cfg: AuthConfig,
  id: VerifiedIdentity,
  now: number,
): Promise<AdmitResult> {
  const email = normalizeEmail(id.email);
  if (!email) return { ok: false, reason: "no_access" };
  if (inDomains(cfg.domains, domainOf(email)))
    return { ok: false, reason: "tenant" };
  const row = await stmt(env.DB, BY_EMAIL)
    .bind(email)
    .first<UserRow & { subject: string | null }>();
  if (!row) return { ok: false, reason: "no_access" };
  if (row.status !== "active") return { ok: false, reason: "removed" };
  if (row.subject === id.subject)
    return admitted(await touch(env, row, id, now));
  if (row.subject) return conflict(env, row.id, now);
  const results = await env.DB.batch<UserRow & { subject: string | null }>([
    stmt(env.DB, PERSONAL_LINK).bind(id.subject, row.id, email, now),
    stmt(env.DB, PERSONAL_ROW).bind(row.id, email),
    stmt(env.DB, PERSONAL_RELINKED).bind(row.id),
  ]);
  const linked = results[1]?.results[0];
  if (!linked) return { ok: false, reason: "no_access" };
  if (linked.status !== "active") return { ok: false, reason: "removed" };
  // Another row holds this subject, or a concurrent link pinned another.
  if (linked.subject !== id.subject) return conflict(env, linked.id, now);
  return admitted(await touch(env, linked, id, now));
}

/** The settings key behind the owner's identity-conflict sign-in problem. */
export const CONFLICT_KEY = "signin_identity_conflict";
/** One audit row per person per hour at most: a retry loop can't flood the log. */
const CONFLICT_AUDIT_EVERY_MS = 60 * 60 * 1000;
/** How long the owner's sign-in problem shows after the latest conflict. */
export const CONFLICT_SHOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A refused sign-in by a Google account other than the one pinned to the
 * person (user `uid`): an auth.refused audit row (reason identity_conflict;
 * no email or subject) and the owner's sign-in problem (settings, CONFLICT_KEY:
 * when and whose row, never an address). Best effort: a failed write never
 * turns the refusal into anything else.
 */
async function conflict(
  env: Env,
  uid: string,
  now: number,
): Promise<AdmitResult> {
  try {
    await env.DB.batch([
      audit(
        env,
        "auth.refused",
        { type: "user", id: uid },
        { kind: "system", id: null, cred: null },
        {
          reason: "identity_conflict",
          detail: { provider: "google" },
          when: {
            sql: `not exists (select 1 from settings where key = ?
              and json_extract(value, '$.uid') = ? and json_extract(value, '$.at') > ?)`,
            args: [CONFLICT_KEY, uid, now - CONFLICT_AUDIT_EVERY_MS],
          },
        },
      ),
      stmt(
        env.DB,
        `insert into settings (key, value) values (?1, ?2)
         on conflict(key) do update set value = excluded.value`,
      ).bind(CONFLICT_KEY, JSON.stringify({ at: now, uid })),
    ]);
  } catch {
    logAuth({ evt: "identity_conflict_flag_failed" });
  }
  return { ok: false, reason: "identity_conflict" };
}

/**
 * The owner's sign-in problem for a recent identity conflict (CONFLICT_KEY's
 * value), else null. Names no one: the audit log has the row.
 */
export function conflictProblem(
  value: string | undefined,
  now = Date.now(),
): string | null {
  if (!value) return null;
  let at: unknown;
  try {
    at = (JSON.parse(value) as { at?: unknown }).at;
  } catch {
    return null;
  }
  if (typeof at !== "number" || at <= now - CONFLICT_SHOWN_MS) return null;
  return "A Google sign-in was refused because the Google account didn't match the one already linked to that person. If they replaced their Google account, reset their Google link on the Members page. If they didn't, someone else may be trying to sign in as them.";
}

/** Google admission rule 1: the tenant (hd) is a verified domain. */
export const googleTenantOk = (
  cfg: AuthConfig,
  tenant: string | null | undefined,
): boolean => inDomains(cfg.domains, tenant);

/** Google admission rule 3: a verified identity with no user row gets one (join = member, or OWNER_EMAIL). */
export const googleNewRowOk = (cfg: AuthConfig, isOwner: boolean): boolean =>
  isOwner || cfg.domainJoin === "member";

/** touch's result: null (no longer active mid-sign-in) is refused, fail closed. */
const admitted = (user: Member | null): AdmitResult =>
  user ? { ok: true, user } : { ok: false, reason: "removed" };

export type CodeEligibility =
  | { kind: "member"; userId: string | null; role: Role }
  | { kind: "guest"; userId: string | null }
  | { kind: "none" };

/** The user row codeRule reads, by email (?1). */
export const ELIGIBILITY = `select u.id, u.role, u.status,
    exists (select 1 from identities i where i.user_id = u.id) as linked
  from users u where u.email = ?1 limit 1`;
const SHARED = "select 1 as x from shares where email = ?1 limit 1";

/**
 * Who may get an emailed code (no writes; checked at request and at verify):
 * - never a user with a Google link, nor a removed or suspended row;
 * - in a verified domain: only while domain codes are on (trial, Google
 *   off): an existing row keeps its role, a new address joins as member if
 *   join = member;
 * - outside the domains: only invited guests (a guest row, or a share and no
 *   row); owner, admin and member rows there never sign in by code.
 */
export async function codeEligibility(
  env: Env,
  cfg: AuthConfig,
  rawEmail: string,
): Promise<CodeEligibility> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { kind: "none" };
  const row = await stmt(env.DB, ELIGIBILITY).bind(email).first<CodeRow>();
  return codeRule(cfg, email, row, async () =>
    Boolean(await stmt(env.DB, SHARED).bind(email).first()),
  );
}

/** The user row codeRule reads: role, status, and whether any identity is linked. */
export type CodeRow = {
  id: string | null;
  role: Role;
  status: string;
  linked: number | boolean;
};

/**
 * codeEligibility's rule for a normalized `email` and its row (null: none);
 * `shared` is asked only for an address outside the domains with no row.
 * Also judges a row about to exist (an invite) in services/reach.ts, so the
 * rule lives in one place.
 */
export async function codeRule(
  cfg: AuthConfig,
  email: string,
  row: CodeRow | null,
  shared: () => Promise<boolean>,
): Promise<CodeEligibility> {
  if (row && (row.status !== "active" || row.linked)) return { kind: "none" };
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (inDomains(cfg.domains, domain)) {
    if (!cfg.domainCodes) return { kind: "none" };
    if (row) return { kind: "member", userId: row.id, role: row.role };
    return cfg.domainJoin === "member"
      ? { kind: "member", userId: null, role: "member" }
      : { kind: "none" };
  }
  if (row)
    return isGuestRole(row.role)
      ? { kind: "guest", userId: row.id }
      : { kind: "none" };
  return (await shared()) ? { kind: "guest", userId: null } : { kind: "none" };
}

/**
 * The member's Google link, never the owner's, and an admin's only when the
 * actor is the owner (?3 = 1). The predicate every reset statement shares, so
 * a role change between the check and the batch can't slip past it.
 */
const TARGET_OK = `u.role <> 'owner' and (u.role <> 'admin' or ?3 = 1)`;
const RESETTABLE = `exists (select 1 from identities i join users u on u.id = i.user_id
  where i.provider = 'google' and u.id = ?1 and ${TARGET_OK})`;
/**
 * An owner or admin: only the owner may act on one (#475). Checked by role,
 * never by link, so a refusal doesn't reveal whether they are linked.
 */
const ADMIN_TARGET =
  "select 1 from users where id = ?1 and role in ('owner', 'admin')";

/**
 * Admin action (owner or admin; 404 for anyone else): removes a member's
 * Google link so their next Google sign-in links afresh (clears an
 * identity_conflict). Never the owner's link; 404 when there is none. An
 * admin's link only by the (uncapped) owner: an admin acting on an admin or
 * the owner gets 403 owner_only whether or not they are linked (it would
 * sign a peer admin out, #475), also when the target was promoted between
 * the check and the batch.
 * One D1 transaction revokes their PATs, ends their sessions and deletes the
 * link, each gated on the same predicate, so all happen or none do. OAuth
 * grants (KV) are revoked first, once the link is known to be resettable, so
 * a KV failure leaves nothing half done. A recycled address
 * that re-links inherits no credential. The row is marked google_relink, so
 * directory sync relinks this same user by email (applyUsers) rather than
 * deleting it as a recycled address.
 */
export async function resetIdentity(
  env: Env,
  actor: Member,
  userId: string,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  if (!orgCan(actor, "members.manage", { cap: capOfCaller(callerOf(actor)) }))
    throw new ApiError("not_found", "Not found");
  const owner = managesAdmins(actor) ? 1 : 0;
  // An owner or admin the actor may not act on is 403 owner_only, linked or
  // not; anything else not resettable stays a 404.
  const refuse = async (): Promise<never> => {
    if (!owner) {
      const admin = await stmt(env.DB, ADMIN_TARGET).bind(userId).first();
      if (admin)
        throw new ApiError(
          "owner_only",
          "Only the owner can reset an admin's Google link",
        );
    }
    throw new ApiError("not_found", "Not found");
  };
  const row = await stmt(env.DB, `select ${RESETTABLE} as ok`)
    .bind(userId, null, owner)
    .first<{ ok: number }>();
  if (!row?.ok) await refuse();
  // Grants (KV) BEFORE the batch, unlike removeMember and setUserStatus, and
  // only once the role precheck above passed, so an owner or admin target
  // is refused before KV is touched. Here the user stays active and nothing
  // in D1 cuts off their grants, so a KV failure after the batch would leave
  // live grants with no retry path (the link is already gone). Revoking first
  // is idempotent and a failure leaves D1 untouched, so the admin can retry.
  // The only race left (a promotion between the precheck and the batch)
  // costs the target a forced reconnect, nothing more.
  await revokeAllGrants(env, userId);
  const results = await env.DB.batch([
    stmt(
      env.DB,
      `update tokens set revoked_at = ?2 where user_id = ?1 and revoked_at is null and ${RESETTABLE}`,
    ).bind(userId, Date.now(), owner),
    stmt(
      env.DB,
      // google_relink: the next directory users page relinks this row by
      // email (applyUsers), never deleting it as a recycled address.
      `update users set session_epoch = session_epoch + 1, google_relink = 1 where id = ?1 and ${RESETTABLE}`,
    ).bind(userId, null, owner),
    // Directly after the session_epoch update (gated on RESETTABLE): audited
    // only when that update changed the row, i.e. the reset happens.
    audit(
      env,
      "identity.reset",
      { type: "user", id: userId },
      userActor(actor.id),
      {
        detail: { provider: "google" },
        when: { sql: "changes() > 0", args: [] },
      },
    ),
    // The owner's identity-conflict problem, when it names this person:
    // the reset is the fix it asks for.
    stmt(
      env.DB,
      `delete from settings where key = ?4 and json_extract(value, '$.uid') = ?1 and ${RESETTABLE}`,
    ).bind(userId, null, owner, CONFLICT_KEY),
    stmt(
      env.DB,
      `delete from identities where provider = 'google'
       and user_id = (select u.id from users u where u.id = ?1 and ${TARGET_OK}) returning 1`,
    ).bind(userId, null, owner),
  ]);
  if (!results[4]?.results.length) await refuse();
  // Sessions and tokens are gone: their live sockets close now (P3 T7).
  await revokeUserLive(env, userId, "identity reset", ctx);
}
