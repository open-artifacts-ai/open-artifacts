import { normalizeEmail } from "@oa/auth-core";
import type { AuditReason } from "@oa/shared";
import { authConfig } from "../auth/config.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { logInfo, logWarn } from "../log.js";
import { revokeUserLive, revokeUsersLive } from "../runtime/revoke.js";
import { type AuditActor, audit } from "../services/audit.js";
import { moveUserEmail } from "../services/email-move.js";
import { SYSTEM_ACTOR, setUserStatus } from "../services/members.js";
import { RESTRICTED_SYNC_CASE } from "../services/restriction.js";
import { bindPage } from "./binding.js";
import type { GoogleUser } from "./google.js";

// Applying directory state (P3 T14). Everything here matches users through
// identities('google', directory id), never by email:
// - applyGroupDiff: a synced group's member diff (install user ids). One D1
//   batch writes the group's flattened directory_members rows, the members'
//   restricted_sync flags, and their space_members(source = 'sync') rows in
//   every space that maps this group (the max over that space's own
//   group_mappings). Every-space mappings are joined at read time and never
//   expanded into rows. Only rows that change are written. The users whose
//   synced role dropped (per space or Every space) and those newly capped
//   have their sockets closed, always, once the batch committed.
// - applyUsers: a page of directory users (listing, Reports re-read or
//   sign-in): deletion, suspension, unsuspension (never reviving a removed
//   row), a new primary address (shares follow the person), and a recycled
//   address (a new directory id
//   behind an address an old row still holds: that row gets the deletion
//   treatment first, then the new row is created), except a row whose link
//   an admin reset (google_relink): it is relinked by email instead.

/** Throws when a reset landed since the caller started (DirectorySync). */
export type Guard = () => void;
type Ctx = Pick<ExecutionContext, "waitUntil">;
const noGuard: Guard = () => {};

const rank = (c: string) =>
  `(case ${c} when 'manager' then 3 when 'editor' then 2 when 'viewer' then 1 else 0 end)`;
const roleOf = (r: string) =>
  `(case ${r} when 3 then 'manager' when 2 then 'editor' else 'viewer' end)`;

// ?1 group id, ?2 touched user ids (JSON), ?3 now.
const IN_U = "(select value from json_each(?2))";
const SPACES_OF = "(select space_id from group_mappings where group_id = ?1)";
/** The synced role a space_members row should hold now (null: none). */
const WANT = `(select max(${rank("gm.role")}) from group_mappings gm
  join directory_members dm on dm.group_id = gm.group_id
  where gm.space_id = space_members.space_id and dm.user_id = space_members.user_id)`;

export const ADD_MEMBERS = `insert or ignore into directory_members (group_id, user_id, gen)
  select ?1, value, ?3 from json_each(?2)
  where exists (select 1 from users where id = value)`;
export const REMOVE_MEMBERS = `delete from directory_members
  where group_id = ?1 and user_id in (select value from json_each(?2))`;
/** restricted_sync recomputed for the listed users; returns those that changed. */
const RESTRICTED_FOR_USERS = `update users set restricted_sync = ${RESTRICTED_SYNC_CASE}
  where id in (select value from json_each(?1))
    and restricted_sync <> ${RESTRICTED_SYNC_CASE}
  returning id, restricted_sync as r`;
const SYNC_DROP = `delete from space_members
  where source = 'sync' and user_id in ${IN_U} and space_id in ${SPACES_OF}
    and ${WANT} is null
  returning user_id`;
const SYNC_LOWER = `update space_members set role = ${roleOf(WANT)}
  where source = 'sync' and user_id in ${IN_U} and space_id in ${SPACES_OF}
    and ${WANT} < ${rank("role")}
  returning user_id`;
const SYNC_RAISE = `update space_members set role = ${roleOf(WANT)}
  where source = 'sync' and user_id in ${IN_U} and space_id in ${SPACES_OF}
    and ${WANT} > ${rank("role")}`;
const SYNC_ADD = `insert into space_members (space_id, user_id, role, source, created_at)
  select gm.space_id, dm.user_id, ${roleOf(`max(${rank("gm.role")})`)}, 'sync', ?3
  from group_mappings gm
  join directory_members dm on dm.group_id = gm.group_id
  join users u on u.id = dm.user_id
  where gm.space_id in ${SPACES_OF} and dm.user_id in ${IN_U}
    and u.status <> 'removed'
    and not exists (select 1 from space_members x where x.space_id = gm.space_id
      and x.user_id = dm.user_id and x.source = 'sync')
  group by gm.space_id, dm.user_id`;
/** Each listed user's Every-space rank (only users with one). */
const ORG_RANK = `select dm.user_id as id, max(${rank("om.role")}) as r
  from directory_members dm join org_group_mappings om on om.group_id = dm.group_id
  where dm.user_id in (select value from json_each(?1)) group by dm.user_id`;
/** Owners and admins joining group ?1 while it is restricted: logged, skipped. */
const UNRESTRICTABLE = `select id from users
  where id in (select value from json_each(?2)) and role in ('owner', 'admin')
    and exists (select 1 from restricted_groups where group_id = ?1)
    and not exists (select 1 from directory_members dm
      where dm.group_id = ?1 and dm.user_id = users.id)`;

export type GroupDiffOpts = {
  /** Statements committed first in the same batch (DirectorySync's audits). */
  pre?: D1PreparedStatement[];
  /** Re-checked right before the batch. */
  guard?: Guard;
  now?: number;
  ctx?: Ctx;
};

/** Users per applyGroupDiff batch: a big diff never makes one huge batch. */
export const DIFF_CHUNK = 200;

/**
 * Applies one synced group's member diff (install user ids), DIFF_CHUNK
 * users per D1 batch (`pre` joins the first), and closes the sockets of
 * everyone each committed batch narrowed or newly capped. Resolves to the
 * narrowed (a per-space or Every-space role dropped) and the capped. A
 * failure after some batches committed leaves a smaller diff for the next
 * sweep (each batch is idempotent).
 */
export async function applyGroupDiff(
  env: Env,
  groupId: string,
  added: string[],
  removed: string[],
  actor: AuditActor,
  o: GroupDiffOpts = {},
): Promise<{ narrowed: string[]; capped: string[] }> {
  const guard = o.guard ?? noGuard;
  if (!added.length && !removed.length) {
    if (o.pre?.length) {
      guard();
      await env.DB.batch(o.pre);
    }
    return { narrowed: [], capped: [] };
  }
  const now = o.now ?? Date.now();
  const narrowed: string[] = [];
  const capped: string[] = [];
  const all = [
    ...added.map((id) => [id, true] as const),
    ...removed.map((id) => [id, false] as const),
  ];
  for (let i = 0; i < all.length; i += DIFF_CHUNK) {
    const part = all.slice(i, i + DIFF_CHUNK);
    const out = await applyChunk(
      env,
      groupId,
      part.filter((x) => x[1]).map((x) => x[0]),
      part.filter((x) => !x[1]).map((x) => x[0]),
      actor,
      i === 0 ? (o.pre ?? []) : [],
      guard,
      now,
      o.ctx,
    );
    narrowed.push(...out.narrowed);
    capped.push(...out.capped);
  }
  return { narrowed, capped };
}

/**
 * One batch of applyGroupDiff (at most DIFF_CHUNK users), then the sockets
 * of the users it narrowed or capped close.
 */
async function applyChunk(
  env: Env,
  groupId: string,
  added: string[],
  removed: string[],
  actor: AuditActor,
  pre: D1PreparedStatement[],
  guard: Guard,
  now: number,
  ctx?: Ctx,
): Promise<{ narrowed: string[]; capped: string[] }> {
  const touched = JSON.stringify([...new Set([...added, ...removed])]);
  const addJson = JSON.stringify(added);
  const remJson = JSON.stringify(removed);
  // Read first: owners and admins joining a restricted group are logged.
  const skip = added.length
    ? (
        await stmt(env.DB, UNRESTRICTABLE)
          .bind(groupId, addJson)
          .all<{ id: string }>()
      ).results.map((r) => r.id)
    : [];
  const org = removed.length > 0;
  const head = pre.length + (org ? 1 : 0);
  guard();
  const out = await env.DB.batch([
    ...pre,
    ...(org ? [stmt(env.DB, ORG_RANK).bind(remJson)] : []),
    stmt(env.DB, ADD_MEMBERS).bind(groupId, addJson, now),
    stmt(env.DB, REMOVE_MEMBERS).bind(groupId, remJson),
    stmt(env.DB, RESTRICTED_FOR_USERS).bind(touched),
    stmt(env.DB, SYNC_DROP).bind(groupId, touched),
    stmt(env.DB, SYNC_LOWER).bind(groupId, touched),
    stmt(env.DB, SYNC_RAISE).bind(groupId, touched),
    stmt(env.DB, SYNC_ADD).bind(groupId, touched, now),
    ...(org ? [stmt(env.DB, ORG_RANK).bind(remJson)] : []),
    ...skip.map((id) =>
      audit(env, "directory.sync", { type: "user", id }, actor, {
        detail: { skipped: "restrict_admin", groupId },
      }),
    ),
  ]);
  const rows = <T>(i: number) => (out[i]?.results ?? []) as T[];
  const capped = rows<{ id: string; r: number }>(head + 2)
    .filter((x) => x.r === 1)
    .map((x) => x.id);
  const narrowed = new Set<string>();
  for (const i of [head + 3, head + 4])
    for (const r of rows<{ user_id: string }>(i)) narrowed.add(r.user_id);
  if (org) {
    const after = new Map(
      rows<{ id: string; r: number }>(head + 7).map((x) => [x.id, x.r]),
    );
    for (const b of rows<{ id: string; r: number }>(pre.length))
      if ((after.get(b.id) ?? 0) < b.r) narrowed.add(b.id);
  }
  if (skip.length)
    logInfo("directory_restrict_admin_skipped", { n: skip.length });
  // Never guarded: the batch committed, so its socket closes always follow.
  await revokeUsersLive(
    env,
    [...narrowed, ...capped],
    "directory group change",
    ctx,
  );
  return { narrowed: [...narrowed], capped };
}

// ------------------------------------------------------------ users

const placeholder = (id: string) => `removed+${id}@invalid`;

/**
 * Each listed directory user's install row (by identity) and the row now
 * holding its primary address: that row's Google subject, and whether it is
 * a pure invite (active, never signed in, no identity of any provider).
 */
const ROWS = `select json_extract(j.value, '$.id') as sub,
    u.id as uid, u.email, u.status, u.role = 'owner' as owner,
    h.id as hid, h.role = 'owner' as howner, h.status as hstatus,
    (select hi.subject from identities hi where hi.provider = 'google' and hi.user_id = h.id) as hsub,
    h.google_relink as hrelink,
    (h.status = 'active' and h.last_seen_at is null
      and not exists (select 1 from identities hx where hx.user_id = h.id)) as hinvite
  from json_each(?1) j
  left join identities i on i.provider = 'google' and i.subject = json_extract(j.value, '$.id')
  left join users u on u.id = i.user_id
  left join users h on h.email = json_extract(j.value, '$.email')`;

// The deletion treatment, gated on the row now being removed (never the
// owner): the shares the user holds, their memberships, then the address.
// Shares are keyed by address only, and every address change re-keys them
// (services/email-move.ts), so the shares a user holds are exactly those on
// their current address.
const GONE =
  "exists (select 1 from users where id = ?1 and status = 'removed' and role <> 'owner')";
const DROP_SHARES = `delete from shares where ${GONE}
  and email = (select email from users where id = ?1)`;
const DROP_MEMBERSHIPS = `delete from space_members where user_id = ?1 and ${GONE}`;
const PLACEHOLDER = `update users set email = ?2 where id = ?1 and email <> ?2 and ${GONE}`;
/**
 * An admin reset the link of the row at the address (?5): that same row
 * takes the directory user's id (?2). As LINK_BY_EMAIL, never onto a row
 * that has a Google identity; never a removed row.
 */
const RELINK = `insert or ignore into identities
  (provider, subject, tenant, user_id, created_at, directory_bound)
  select 'google', ?2, ?3, ?1, ?4, 1
  where exists (select 1 from users where id = ?1 and email = ?5
      and google_relink = 1 and status <> 'removed')
    and not exists (select 1 from identities
      where provider = 'google' and user_id = ?1)`;
/** The relink consumed: only once the row holds that identity. */
const RELINKED = `update users set google_relink = 0 where id = ?1 and google_relink = 1
  and exists (select 1 from identities where provider = 'google' and subject = ?2 and user_id = ?1)`;
/** A pure invite at the address (?5) becomes the directory user's row. */
const LINK_INVITE = `insert or ignore into identities
  (provider, subject, tenant, user_id, created_at, directory_bound)
  select 'google', ?2, ?3, ?1, ?4, 1
  where exists (select 1 from users where id = ?1 and email = ?5
      and status = 'active' and last_seen_at is null)
    and not exists (select 1 from identities where user_id = ?1)`;

export type ApplyUsersOpts = {
  /** The binding's domain (the identity tenant for created rows). */
  tenant: string;
  guard?: Guard;
  ctx?: Ctx;
  /**
   * users.get by directory id: null when Google no longer has the user. Used
   * when a new id shows up behind an address an old row holds, to tell a
   * renamed old user from a deleted one.
   */
  lookup?: (id: string) => Promise<GoogleUser | null>;
};

type Row = {
  sub: string;
  uid: string | null;
  email: string | null;
  status: string | null;
  owner: number | null;
  hid: string | null;
  howner: number | null;
  hsub: string | null;
  hstatus: string | null;
  hinvite: number | null;
  hrelink: number | null;
};

/** One directory user (the plan's applyUser); `run` names the pass in logs. */
export function applyUser(
  env: Env,
  u: GoogleUser,
  run: string,
  o: ApplyUsersOpts,
): Promise<void> {
  logInfo("directory_apply_user", { run });
  return applyUsers(env, [u], o);
}

/**
 * Applies a page of directory users by identity. Reads once; writes only
 * for the users whose install row has to change, so a steady listing writes
 * nothing. Suspensions and deletions are never held, and apply by id even
 * when the listed address is unusable.
 */
export async function applyUsers(
  env: Env,
  page: GoogleUser[],
  o: ApplyUsersOpts,
): Promise<void> {
  const guard = o.guard ?? noGuard;
  if (!page.length) return;
  const list = page.map((u) => ({
    u,
    email: normalizeEmail(u.primaryEmail) || null,
  }));
  const { results } = await stmt(env.DB, ROWS)
    .bind(JSON.stringify(list.map((x) => ({ id: x.u.id, email: x.email }))))
    .all<Row>();
  const bySub = new Map(results.map((r) => [r.sub, r]));
  const domains = new Set(authConfig(env).domains);
  for (const { u, email } of list) {
    const r = bySub.get(u.id);
    if (!r) continue;
    if (r.uid) {
      await applyLinked(env, u, email, r as Row & { uid: string }, guard, o);
      continue;
    }
    // Unknown id behind an address another row holds (a free address is
    // created by bindPage in the listings).
    if (!email || u.deleted || u.suspended || !r.hid) continue;
    if (r.hsub === u.id) continue;
    if (!domains.has(email.slice(email.lastIndexOf("@") + 1))) continue;
    if (r.howner) {
      logWarn("directory_recycled_owner_address");
      continue;
    }
    if (!r.hsub) {
      // No Google link. An admin reset it (google_relink): the same person,
      // relinked by email, keeping their id, shares and spaces.
      if (r.hrelink && r.hstatus !== "removed") {
        guard();
        await env.DB.batch([
          stmt(env.DB, RELINK).bind(r.hid, u.id, o.tenant, Date.now(), email),
          stmt(env.DB, RELINKED).bind(r.hid, u.id),
        ]);
        logInfo("directory_relinked_after_reset");
        continue;
      }
      // A pure invite (never signed in) is this person's
      // row: link it. A row with sign-in history is a recycled address:
      // the deletion treatment, so nothing is inherited.
      if (r.hinvite) {
        guard();
        await stmt(env.DB, LINK_INVITE)
          .bind(r.hid, u.id, o.tenant, Date.now(), email)
          .run();
        continue;
      }
      await deleteUser(env, r.hid, "directory_new_id", guard, o.ctx);
    } else {
      // A new directory id behind an address an old Google-linked row holds:
      // the old user renamed (their row and shares follow them), or gone
      // (deletion treatment, which also cuts that address's shares and
      // memberships: decision 2). Without users.get (no lookup) nothing is
      // removed on this signal.
      if (!o.lookup) continue;
      const old = await o.lookup(r.hsub);
      const oldEmail =
        old && !old.deleted ? normalizeEmail(old.primaryEmail) : null;
      if (oldEmail && oldEmail !== email && r.hstatus !== "removed")
        await changeEmail(env, r.hid, email, oldEmail, guard);
      else await deleteUser(env, r.hid, "directory_new_id", guard, o.ctx);
    }
    // The address is free now: T12's bindPage creates the row (in domain,
    // active) and its identity; its personal space comes from the trigger.
    guard();
    await bindPage(env, [u], {
      tenant: o.tenant,
      allowEmail: false,
      ctx: o.ctx,
      guard,
    });
  }
}

async function applyLinked(
  env: Env,
  u: GoogleUser,
  email: string | null,
  r: Row & { uid: string },
  guard: Guard,
  o: ApplyUsersOpts,
) {
  if (u.deleted) {
    if (r.owner) return;
    if (r.status !== "removed" || r.email !== placeholder(r.uid))
      await deleteUser(env, r.uid, "directory_delete", guard, o.ctx);
    return;
  }
  // A removed row is never revived nor renamed.
  if (r.status === "removed") return;
  if (u.suspended && r.status === "active") {
    guard();
    await setUserStatus(
      env,
      r.uid,
      "suspended",
      "directory_suspend",
      SYSTEM_ACTOR,
      o.ctx,
    );
  } else if (!u.suspended && r.status === "suspended") {
    guard();
    await setUserStatus(
      env,
      r.uid,
      "active",
      "directory_unsuspend",
      SYSTEM_ACTOR,
      o.ctx,
    );
  }
  if (email && r.email && r.email !== email)
    await changeEmail(env, r.uid, r.email, email, guard);
}

/**
 * The deletion treatment: removed (setUserStatus), then in one batch the
 * shares the user holds (their current address's), every space membership
 * (sync and manual) and the address itself (a placeholder), then the
 * sockets close. Never the owner (setUserStatus and every statement exclude
 * that row).
 */
export async function deleteUser(
  env: Env,
  uid: string,
  why: AuditReason,
  guard: Guard,
  ctx?: Ctx,
): Promise<void> {
  guard();
  await setUserStatus(env, uid, "removed", why, SYSTEM_ACTOR, ctx);
  // Not re-guarded: the removal committed, and deletions are never held.
  await env.DB.batch([
    stmt(env.DB, DROP_SHARES).bind(uid),
    stmt(env.DB, DROP_MEMBERSHIPS).bind(uid),
    stmt(env.DB, PLACEHOLDER).bind(uid, placeholder(uid)),
  ]);
  await revokeUserLive(env, uid, "directory delete", ctx);
}

/** A new primary address: the shared move (shares follow the person). */
async function changeEmail(
  env: Env,
  uid: string,
  from: string,
  to: string,
  guard: Guard,
): Promise<void> {
  guard();
  if (!(await moveUserEmail(env, uid, from, to)))
    logWarn("directory_email_taken");
}
