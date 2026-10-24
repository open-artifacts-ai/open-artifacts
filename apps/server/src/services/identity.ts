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

/** Name, last-seen, guest promotion (hd verified) and owner role on sign-in. */
async function touch(
  env: Env,
  row: UserRow,
  id: VerifiedIdentity,
  now: number,
): Promise<Member | null> {
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
                     when role = 'guest' then 'member' else role end
       where id = ?3 and status = 'active'
       returning id, email, name, display_name as displayName, role, last_seen_at as lastSeenAt, status`,
    ).bind(now, id.name, row.id, owner && row.email === owner ? 1 : 0),
    signInAudit(env, row.id, id.provider, id.tenant, {
      sql: "changes() > 0",
      args: [],
    }),
  ]);
  const out = res?.results[0];
  return out ? member(out) : null;
}

/** Moves a linked user to their new verified address when nobody else has it. */
async function followDrift(
  env: Env,
  row: UserRow,
  email: string,
): Promise<UserRow> {
  if (email === row.email) return row;
  // Never onto OWNER_EMAIL: drift must not hand anyone the owner address.
  if (email === normalizeEmail(env.OWNER_EMAIL ?? "")) {
    logDrift();
    return row;
  }
  try {
    const out = await stmt(
      env.DB,
      `update users set email = ?1 where id = ?2 and not exists (select 1 from users where email = ?1)
       returning id, email, name, display_name as displayName, role, last_seen_at as lastSeenAt, status`,
    )
      .bind(email, row.id)
      .first<UserRow>();
    if (out) return out;
  } catch {
    // A concurrent insert took the address: keep the old one.
  }
  logDrift();
  return row;
}

/**
 * Admits a verified Google identity:
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
  if (!inDomains(cfg.domains, id.tenant))
    return { ok: false, reason: "tenant" };
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
  if (existing?.subject) return { ok: false, reason: "identity_conflict" };
  // OWNER_EMAIL is special only while no owner exists; then normal join rules.
  const isOwner =
    email === normalizeEmail(env.OWNER_EMAIL ?? "") &&
    !(await stmt(env.DB, AN_OWNER).first());
  if (!existing && !isOwner && cfg.domainJoin !== "member")
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
  if (row.subject !== id.subject)
    return { ok: false, reason: "identity_conflict" };
  return admitted(await touch(env, row, id, now));
}

/** touch's result: null (no longer active mid-sign-in) is refused, fail closed. */
const admitted = (user: Member | null): AdmitResult =>
  user ? { ok: true, user } : { ok: false, reason: "removed" };

export type CodeEligibility =
  | { kind: "member"; userId: string | null; role: Role }
  | { kind: "guest"; userId: string | null }
  | { kind: "none" };

const ELIGIBILITY = `select u.id, u.role, u.status,
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
  const row = await stmt(env.DB, ELIGIBILITY)
    .bind(email)
    .first<{ id: string; role: Role; status: string; linked: number }>();
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
  const shared = await stmt(env.DB, SHARED).bind(email).first();
  return shared ? { kind: "guest", userId: null } : { kind: "none" };
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
 * that re-links inherits no credential.
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
      `update users set session_epoch = session_epoch + 1 where id = ?1 and ${RESETTABLE}`,
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
    stmt(
      env.DB,
      `delete from identities where provider = 'google'
       and user_id = (select u.id from users u where u.id = ?1 and ${TARGET_OK}) returning 1`,
    ).bind(userId, null, owner),
  ]);
  if (!results[3]?.results.length) await refuse();
  // Sessions and tokens are gone: their live sockets close now (P3 T7).
  await revokeUserLive(env, userId, "identity reset", ctx);
}
