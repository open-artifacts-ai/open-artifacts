import { googleEvidenceStrong, inDomains, normalizeEmail } from "@oa/auth-core";
import type { Member, Role } from "@oa/shared";
import { logAuth } from "../auth/audit.js";
import {
  callerOf,
  capOfCaller,
  inviteTtlDays,
  isAdminRow,
  managesAdmins,
} from "../auth/authz.js";
import type { AuthConfig, IdentityProvider } from "../auth/config.js";
import { isGuestRole, isMemberRole, orgCan } from "../auth/policy.js";
import type { VerifiedIdentity } from "../auth/providers/types.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { revokeAllGrants } from "../mcp/oauth-api.js";
import { revokeUserLive } from "../runtime/revoke.js";
import { audit, inviteAcceptAudit, signInAudit, userActor } from "./audit.js";
import { moveUserEmail } from "./email-move.js";
import { outsiderLoginOff } from "./outside.js";
import { identityLinkStmts, toMember } from "./users.js";

// Admission and account linking for direct sign-in (P2). identities
// (provider, subject) is the only link; email links an existing ACTIVE row at
// most once, never a removed or suspended one.

export type AdmitResult =
  | { ok: true; user: Member }
  | {
      ok: false;
      reason:
        | "tenant"
        | "identity_conflict"
        | "removed"
        | "no_access"
        /** Weak evidence for a first link to an existing row: the code step (slice 2) is not built, so refused. */
        | "needs_code"
        /** A never-signed-in invited row past its window (30 days, 7 for an admin). */
        | "invite_expired";
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
// subject: the row's link for THIS provider (?2), so another provider's link
// is never an identity_conflict.
const BY_EMAIL = `select ${USER_COLS}, u.invited_at as invitedAt, (select subject from identities i where i.user_id = u.id and i.provider = ?2) as subject
  from users u where u.email = ?1 limit 1`;

const AN_OWNER = "select 1 as x from users where role = 'owner' limit 1";

const member = (r: UserRow) => toMember(r as Parameters<typeof toMember>[0]);

const logDrift = () => logAuth({ evt: "email_drift", outcome: "kept" });

/**
 * Google and Access keep today's admission (#3087). Any other provider is
 * link-only: it signs in by a linked subject, and otherwise only reaches an
 * existing active row through the emailed code. It never creates a row,
 * promotes a guest, becomes the owner, or follows email drift.
 */
const linkOnly = (p: IdentityProvider): boolean =>
  p !== "google" && p !== "access";

/** Name, last-seen and owner role on sign-in; never a guest's role (#2590). */
async function touch(
  env: Env,
  row: UserRow,
  id: VerifiedIdentity,
  now: number,
): Promise<Member | null> {
  // An email-bound identity never becomes the owner (#2520).
  // Nor does a link-only provider's.
  const owner =
    id.bound || linkOnly(id.provider)
      ? ""
      : normalizeEmail(env.OWNER_EMAIL ?? "");
  // The role is kept from the row's CURRENT role, in SQL, never written back
  // from the read above: an admin demotion racing this sign-in sticks (P3 T6).
  // No login path changes a guest's role (#2590): only an admin's invite makes
  // a member, a listed domain or not.
  // OWNER_EMAIL becomes owner only while no owner row exists (one owner).
  // An active row only: a user who stopped being active mid-sign-in matches
  // no row, gets no auth.signin row, and is refused (null). The admission
  // and its audit row commit together.
  const [, res] = await env.DB.batch<UserRow>([
    // Before the update below, which sets last_seen_at (invite.accept reads it).
    inviteAcceptAudit(env, row.id),
    stmt(
      env.DB,
      `update users set last_seen_at = ?1, name = coalesce(?2, name),
         role = case when ?4 = 1 and not exists (select 1 from users where role = 'owner') then 'owner'
                     else role end
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

/**
 * Moves a linked user to their new verified address when nobody else has it,
 * with their shares (moveUserEmail: a freed address inherits nothing).
 */
async function followDrift(
  env: Env,
  row: UserRow,
  email: string,
  id: VerifiedIdentity,
): Promise<UserRow> {
  if (email === row.email) return row;
  // Only strong evidence for the NEW address moves a row, and never an
  // email-bound identity: otherwise a login whose hd is not a listed domain
  // (or a consumer account on a work address) could walk a row onto another
  // address, in-domain ones included (#2520 M1, Axe 4). The user keeps
  // their old address and still signs in by subject.
  if (id.bound || !googleEvidenceStrong(email, true, id.hd ?? id.tenant)) {
    logDrift();
    return row;
  }
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
 * Admits a verified Google identity:
 * 1. The tenant (hd) must still be a verified domain (no domains: no check).
 * 2. Linked (provider, subject): that user, unless not active (removed);
 *    follow email drift when the new address is free.
 * 3. Unlinked: an existing row with the email must be active (else removed)
 *    and have no other Google link (else identity_conflict); a new row needs
 *    join = member or OWNER_EMAIL (else no_access). Created and linked in one
 *    race-safe batch (identityLinkStmts).
 * Any other provider (linkOnly) skips rules 1 and 3 and drift: see
 * admitLinkOnly.
 * A guest promoted to member here is safe: hd proves domain membership. With
 * no domains (no tenant) a guest stays a guest: nothing proves membership.
 */
export async function admit(
  env: Env,
  cfg: AuthConfig,
  raw: VerifiedIdentity,
  now = Date.now(),
): Promise<AdmitResult> {
  // No domains: there is no tenant, whatever the token said.
  // An email-bound identity has no tenant, whatever else it carries.
  const id: VerifiedIdentity =
    cfg.domains.length === 0 || raw.bound ? { ...raw, tenant: null } : raw;
  if (linkOnly(id.provider)) return admitLinkOnly(env, id, now);
  if (!id.bound && !googleTenantOk(cfg, id.tenant))
    return { ok: false, reason: "tenant" };
  const email = normalizeEmail(id.email);
  if (!email) return { ok: false, reason: "no_access" };

  const linked = await stmt(env.DB, BY_SUBJECT)
    .bind(id.provider, id.subject)
    .first<UserRow>();
  if (linked) {
    if (linked.status !== "active") return { ok: false, reason: "removed" };
    // A guest a share made, with no share left: no way in (#2590).
    if (
      (await unsharedGuest(env, linked)) ||
      (isGuestRole(linked.role as Role) &&
        (await outsiderLoginOff(env, linked.id, linked.email)))
    )
      return { ok: false, reason: "no_access" };
    return admitted(
      await touch(env, await followDrift(env, linked, email, id), id, now),
    );
  }

  const existing = await stmt(env.DB, BY_EMAIL).bind(email, id.provider).first<
    UserRow & {
      subject: string | null;
      invitedAt: number | null;
    }
  >();
  if (existing && existing.status !== "active")
    return { ok: false, reason: "removed" };
  if (existing?.subject) return { ok: false, reason: "identity_conflict" };
  if (
    existing &&
    ((await unsharedGuest(env, existing)) ||
      (isGuestRole(existing.role as Role) &&
        (await outsiderLoginOff(env, existing.id, existing.email))))
  )
    return { ok: false, reason: "no_access" };
  if (existing) {
    // A pending invite (invited_at set, never signed in) lapses; a re-invite
    // refreshes it. Rows nobody invited (directory sync, share guests) never do.
    // A colleague whose token hd is a listed domain, with join = member, is
    // not blocked by a lapsed non-admin invite: the domain path would admit
    // them anyway, so the row links as that path would (the strong-evidence
    // check below still applies). An admin's lapsed invite always holds.
    const domainJoins =
      Boolean(id.tenant) &&
      cfg.domainJoin === "member" &&
      !isAdminRow(existing.role);
    if (!domainJoins && inviteLapsed(existing, now))
      return { ok: false, reason: "invite_expired" };
    // First link of this Google account to an existing row (invited, code-only
    // member or admin, guest): only strong evidence links directly (#2520
    // M1). Weak evidence needs the emailed code, which slice 2 builds; until
    // then it is refused. The token's hd, never the address, decides.
    if (
      !id.emailVerified ||
      !googleEvidenceStrong(email, true, id.hd ?? id.tenant)
    )
      return { ok: false, reason: "needs_code" };
  }
  // OWNER_EMAIL is special only while no owner exists; then normal join rules.
  const isOwner =
    email === normalizeEmail(env.OWNER_EMAIL ?? "") &&
    !(await stmt(env.DB, AN_OWNER).first());
  // No row: a bound identity (#2520) never creates a member or the owner,
  // whatever AUTH_DOMAIN_JOIN says. Nor does an address no join rule admits.
  // Either way a live share to the exact address makes a GUEST (#2590), on
  // strong evidence only (weak: needs_code; no share: no_access). A guest
  // stays a guest, a listed domain or not.
  let role: Role = isOwner ? "owner" : "member";
  if (!existing && (id.bound || !googleNewRowOk(cfg, isOwner))) {
    if (!(await stmt(env.DB, SHARED).bind(email).first()))
      return { ok: false, reason: "no_access" };
    // The owner's switch (#2590): off ends share-made guests' logins.
    if (await outsiderLoginOff(env, null, email))
      return { ok: false, reason: "no_access" };
    if (
      !id.emailVerified ||
      !googleEvidenceStrong(email, true, id.hd ?? id.tenant)
    )
      return { ok: false, reason: "needs_code" };
    role = "guest";
  }

  // An invited row (never seen) accepts its invite here: the audit statement
  // goes first, while last_seen_at is still null (the link sets it).
  const lead = existing ? [inviteAcceptAudit(env, existing.id)] : [];
  const results = await env.DB.batch<UserRow & { subject: string | null }>([
    ...lead,
    ...identityLinkStmts(env, {
      provider: id.provider,
      email,
      name: id.name,
      role,
      subject: id.subject,
      tenant: id.tenant ?? "",
      now,
    }),
  ]);
  const row = results[2 + lead.length]?.results[0];
  if (!row) return { ok: false, reason: "no_access" };
  if (row.status !== "active") return { ok: false, reason: "removed" };
  if (row.subject !== id.subject)
    return { ok: false, reason: "identity_conflict" };
  return admitted(await touch(env, row, id, now));
}

/**
 * admit() for a link-only provider (#3087): no tenant rule (the hd rule is
 * Google's), no drift. Linked: that user, as admit does. Unlinked: an
 * existing ACTIVE row is required (else no_access); a lapsed invite is
 * invite_expired; otherwise needs_code, always, whatever the provider says
 * about the address: the emailed code makes the first link (verifyLink).
 */
async function admitLinkOnly(
  env: Env,
  id: VerifiedIdentity,
  now: number,
): Promise<AdmitResult> {
  const blocked = async (r: UserRow) =>
    (await unsharedGuest(env, r)) ||
    (isGuestRole(r.role as Role) &&
      (await outsiderLoginOff(env, r.id, r.email)));
  const linked = await stmt(env.DB, BY_SUBJECT)
    .bind(id.provider, id.subject)
    .first<UserRow>();
  if (linked) {
    if (linked.status !== "active") return { ok: false, reason: "removed" };
    if (await blocked(linked)) return { ok: false, reason: "no_access" };
    return admitted(await touch(env, linked, id, now));
  }
  // The address matters only for a first link: a linked subject signs in by
  // its stable id alone, whatever email the provider sends this time.
  const email = normalizeEmail(id.email);
  if (!email) return { ok: false, reason: "no_access" };
  const existing = await stmt(env.DB, BY_EMAIL)
    .bind(email, id.provider)
    .first<UserRow & { subject: string | null; invitedAt: number | null }>();
  if (existing?.status !== "active") return { ok: false, reason: "no_access" };
  if (existing.subject) return { ok: false, reason: "identity_conflict" };
  if (await blocked(existing)) return { ok: false, reason: "no_access" };
  if (inviteLapsed(existing, now))
    return { ok: false, reason: "invite_expired" };
  return { ok: false, reason: "needs_code" };
}

/**
 * A guest a share made (no invite) who has no share left, and no space role:
 * they exist only through shares, so they can't log in (#2590). Normally the
 * last share's removal has deactivated them already; this is the fence.
 */
const UNSHARED = `select 1 as x from users u where u.id = ?1 and u.role = 'guest'
  and u.invited_at is null
  and not exists (select 1 from shares s join artifacts a on a.id = s.artifact_id
    where s.email = u.email and a.deleted_at is null)
  and not exists (select 1 from space_members sm where sm.user_id = u.id)`;
const unsharedGuest = async (env: Env, row: { id: string; role: string }) =>
  isGuestRole(row.role as Role) &&
  (await stmt(env.DB, UNSHARED).bind(row.id).first()) !== null;

/**
 * A pending invite that has lapsed: invited_at set (inviteMember only), never
 * signed in, older than 30 days (7 for an admin). The owner never lapses.
 */
export const inviteLapsed = (
  row: { role: string; invitedAt: number | null; lastSeenAt: number | null },
  now: number,
): boolean =>
  row.invitedAt !== null &&
  row.lastSeenAt === null &&
  (inviteTtlDays(row.role) ?? Infinity) * 86_400_000 < now - row.invitedAt;

/** Google admission rule 1: the tenant (hd) is a verified domain. */
export const googleTenantOk = (
  cfg: AuthConfig,
  tenant: string | null | undefined,
): boolean => cfg.domains.length === 0 || inDomains(cfg.domains, tenant);

/** Google admission rule 3: a verified identity with no user row gets one (join = member, or OWNER_EMAIL). */
export const googleNewRowOk = (cfg: AuthConfig, isOwner: boolean): boolean =>
  isOwner || (cfg.domains.length > 0 && cfg.domainJoin === "member");

/** touch's result: null (no longer active mid-sign-in) is refused, fail closed. */
const admitted = (user: Member | null): AdmitResult =>
  user ? { ok: true, user } : { ok: false, reason: "removed" };

/**
 * Why a code isn't allowed, for the log only (#2656): a fixed word, never the
 * address. bad_address: not an address. row_inactive: the row is removed or
 * suspended. linked: the row has a linked identity (for a link code: one
 * for that provider). invite_expired: a never-signed-in
 * invite past its window. domain_codes_off / domain_no_join: the address is in
 * the login domains, where codes are off or a new address can't join. not_guest:
 * an owner or admin row outside the domains, or a member row there on an
 * install without Google (they never sign in by code).
 * no_share: no row and no live share. outsider_off: the owner's outside-sharing
 * switch is off.
 */
export type CodeWhy =
  | "bad_address"
  | "row_inactive"
  | "linked"
  | "invite_expired"
  | "domain_codes_off"
  | "domain_no_join"
  | "not_guest"
  | "no_share"
  | "outsider_off";

export type CodeEligibility =
  | { kind: "member"; userId: string | null; role: Role }
  | { kind: "guest"; userId: string | null }
  | { kind: "none"; reason?: "invite_expired"; why: CodeWhy };

/** The user row codeRule reads, by email (?1). */
export const ELIGIBILITY = `select u.id, u.role, u.status,
    u.invited_at as invitedAt, u.last_seen_at as lastSeenAt,
    exists (select 1 from identities i where i.user_id = u.id) as linked
  from users u where u.email = ?1 limit 1`;
/**
 * ELIGIBILITY for linking a `?2` identity (#3087): linked is a link for THAT
 * provider only, so a Google-linked member can add GitHub. Plain code
 * sign-in keeps ELIGIBILITY (any identity blocks it).
 */
const LINK_ELIGIBILITY = `select u.id, u.role, u.status,
    u.invited_at as invitedAt, u.last_seen_at as lastSeenAt,
    exists (select 1 from identities i where i.user_id = u.id and i.provider = ?2) as linked
  from users u where u.email = ?1 limit 1`;
// A share on a deleted page admits nothing (#2598 N3).
const SHARED = `select 1 as x from shares s join artifacts a on a.id = s.artifact_id
  where s.email = ?1 and a.deleted_at is null limit 1`;

/**
 * Who may get an emailed code (no writes; checked at request and at verify):
 * - never a user with a Google link, nor a removed or suspended row;
 * - in a verified domain: only while domain codes are on (trial, Google
 *   off): an existing row keeps its role, a new address joins as member if
 *   join = member;
 * - outside the domains: invited guests (a guest row, or a share and no
 *   row), and on a Google install an invited member row at that exact
 *   address (people with no Gmail or Workspace); owner and admin rows there
 *   never sign in by code.
 */
export async function codeEligibility(
  env: Env,
  cfg: AuthConfig,
  rawEmail: string,
): Promise<CodeEligibility> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { kind: "none", why: "bad_address" };
  const row = await stmt(env.DB, ELIGIBILITY)
    .bind(email)
    .first<CodeRow & { invitedAt: number | null; lastSeenAt: number | null }>();
  // The same lapse as a Google sign-in (#2520): no code for an expired invite.
  if (row && row.status === "active" && inviteLapsed(row, Date.now()))
    return { kind: "none", reason: "invite_expired", why: "invite_expired" };
  const rule = await codeRule(cfg, email, row, async () =>
    Boolean(await stmt(env.DB, SHARED).bind(email).first()),
  );
  // The owner's switch (#2590): off ends share-made guests' logins by code too.
  if (
    rule.kind === "guest" &&
    (await outsiderLoginOff(env, rule.userId, email))
  )
    return { kind: "none", why: "outsider_off" };
  return rule;
}

/**
 * Who may get a code to LINK a `provider` account that admit() refused with
 * needs_code (#2590 G2, #3087): the person proved the account, the code
 * proves the mailbox. An active, unlapsed row with no link for this provider
 * (another provider's link doesn't block it) (invited member or admin, or a
 * guest); or, for Google only, no row and a live share (a guest row is made
 * at verify). Never a removed or suspended row, a guest left with no share,
 * or a row that already has a link for this provider. No write; checked at
 * request and verify.
 */
export async function linkEligibility(
  env: Env,
  rawEmail: string,
  provider: IdentityProvider,
): Promise<CodeEligibility> {
  const email = normalizeEmail(rawEmail);
  if (!email) return { kind: "none", why: "bad_address" };
  const row = await stmt(env.DB, LINK_ELIGIBILITY)
    .bind(email, provider)
    .first<CodeRow & { invitedAt: number | null; lastSeenAt: number | null }>();
  if (!row) {
    // A link-only provider never creates a row, not even a share's guest.
    if (linkOnly(provider)) return { kind: "none", why: "no_share" };
    if (!(await stmt(env.DB, SHARED).bind(email).first()))
      return { kind: "none", why: "no_share" };
    return (await outsiderLoginOff(env, null, email))
      ? { kind: "none", why: "outsider_off" }
      : { kind: "guest", userId: null };
  }
  if (row.status !== "active" || !row.id)
    return { kind: "none", why: "row_inactive" };
  if (row.linked) return { kind: "none", why: "linked" };
  if (inviteLapsed(row, Date.now()))
    return { kind: "none", reason: "invite_expired", why: "invite_expired" };
  if (await unsharedGuest(env, { id: row.id, role: row.role }))
    return { kind: "none", why: "no_share" };
  if (isGuestRole(row.role)) {
    if (await outsiderLoginOff(env, row.id, email))
      return { kind: "none", why: "outsider_off" };
    return { kind: "guest", userId: row.id };
  }
  return { kind: "member", userId: row.id, role: row.role };
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
  if (row && row.status !== "active")
    return { kind: "none", why: "row_inactive" };
  if (row?.linked) return { kind: "none", why: "linked" };
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (inDomains(cfg.domains, domain)) {
    if (!cfg.domainCodes) return { kind: "none", why: "domain_codes_off" };
    if (row) return { kind: "member", userId: row.id, role: row.role };
    return cfg.domainJoin === "member"
      ? { kind: "member", userId: null, role: "member" }
      : { kind: "none", why: "domain_no_join" };
  }
  if (row) {
    if (isGuestRole(row.role)) return { kind: "guest", userId: row.id };
    // An invited member with no Gmail or Workspace at the exact invited
    // address (the row's email): a code proves that mailbox, on a Google
    // install too. Owner and admin rows here still never sign in by code.
    if (isMemberRole(row.role) && cfg.providers.has("google"))
      return { kind: "member", userId: row.id, role: "member" };
    return { kind: "none", why: "not_guest" };
  }
  return (await shared())
    ? { kind: "guest", userId: null }
    : { kind: "none", why: "no_share" };
}

/**
 * The member's Google link, never the owner's, and an admin's only when the
 * actor is the owner (?3 = 1). The predicate every reset statement shares, so
 * a role change between the check and the batch can't slip past it.
 */
const TARGET_OK = `u.role <> 'owner' and (u.role <> 'admin' or ?3 = 1)`;
const RESETTABLE = `exists (select 1 from identities i join users u on u.id = i.user_id
  where i.provider = ?4 and u.id = ?1 and ${TARGET_OK})`;
/**
 * An owner or admin: only the owner may act on one (#475). Checked by role,
 * never by link, so a refusal doesn't reveal whether they are linked.
 */
const ADMIN_TARGET =
  "select 1 from users where id = ?1 and role in ('owner', 'admin')";

/**
 * Admin action (owner or admin; 404 for anyone else): removes a member's
 * Google link so their next Google sign-in links afresh (clears an
 * identity_conflict). Provider-aware (#3087): it resets `provider`'s link
 * only (Google by default, the members route's only caller today); another
 * provider's link stays, and only a Google reset sets google_relink. Never
 * the owner's link; 404 when there is none. An
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
  /** The link to reset; Google by default (the members route's only caller). */
  provider: IdentityProvider = "google",
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
    .bind(userId, null, owner, provider)
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
    ).bind(userId, Date.now(), owner, provider),
    stmt(
      env.DB,
      // google_relink: the next directory users page relinks this row by
      // email (applyUsers), never deleting it as a recycled address. Never
      // on an erased row (#1204): its address is gone, so the reset only
      // frees that Google account to come back as a new, empty person.
      // google_relink is Google's (directory sync): another provider's reset
      // leaves it as it is.
      `update users set session_epoch = session_epoch + 1,
        google_relink = case when ?4 <> 'google' then google_relink
                             when erased_at is null then 1 else 0 end
        where id = ?1 and ${RESETTABLE}`,
    ).bind(userId, null, owner, provider),
    // Directly after the session_epoch update (gated on RESETTABLE): audited
    // only when that update changed the row, i.e. the reset happens.
    audit(
      env,
      "identity.reset",
      { type: "user", id: userId },
      userActor(actor.id),
      {
        detail: { provider },
        when: { sql: "changes() > 0", args: [] },
      },
    ),
    // #1291: bus machines go with the PATs. Before the link delete below:
    // RESETTABLE reads that link, so after it this would match nothing.
    stmt(
      env.DB,
      `update bus_machines set revoked_at = ?2 where user_id = ?1 and revoked_at is null and ${RESETTABLE}`,
    ).bind(userId, Date.now(), owner, provider),
    stmt(
      env.DB,
      `delete from identities where provider = ?4
       and user_id = (select u.id from users u where u.id = ?1 and ${TARGET_OK}) returning 1`,
    ).bind(userId, null, owner, provider),
  ]);
  // results[4]: the link delete's returning row.
  if (!results[4]?.results.length) await refuse();
  // Sessions and tokens are gone: their live sockets close now (P3 T7).
  await revokeUserLive(env, userId, "identity reset", ctx);
}
