import { normalizeEmail } from "@oa/auth-core";
import type { AuditReason } from "@oa/shared";
import { authConfig } from "../auth/config.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { logInfo, logWarn } from "../log.js";
import { revokeUserLive, revokeUsersLive } from "../runtime/revoke.js";
import { type AuditActor, audit } from "../services/audit.js";
import { setUserStatus } from "../services/members.js";
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
//   treatment first, then the new row is created).

/** Throws when a reset landed since the caller started (DirectorySync). */
export type Guard = () => void;
type Ctx = Pick<ExecutionContext, "waitUntil">;
const noGuard: Guard = () => {};
const SYNC: AuditActor = { kind: "sync", id: null };

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

/**
 * Applies one synced group's member diff (install user ids) in one D1 batch
 * and closes the sockets of everyone it narrowed or newly capped. Resolves
 * to the narrowed (a per-space or Every-space role dropped) and the capped.
 */
export async function applyGroupDiff(
  env: Env,
  groupId: string,
  added: string[],
  removed: string[],
  actor: AuditActor,
  o: GroupDiffOpts = {},
): Promise<{ narrowed: string[]; capped: string[] }> {
  const pre = o.pre ?? [];
  const guard = o.guard ?? noGuard;
  if (!added.length && !removed.length) {
    if (pre.length) {
      guard();
      await env.DB.batch(pre);
    }
    return { narrowed: [], capped: [] };
  }
  const now = o.now ?? Date.now();
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
    o.ctx,
  );
  return { narrowed: [...narrowed], capped };
}

// ------------------------------------------------------------ users

const placeholder = (id: string) => `removed+${id}@invalid`;

/**
 * Each listed directory user's install row (by identity) and the row now
 * holding its primary address (with that row's Google subject, if any).
 */
const ROWS = `select json_extract(j.value, '$.id') as sub,
    u.id as uid, u.email, u.status, u.role = 'owner' as owner,
    h.id as hid, h.role = 'owner' as howner, h.status as hstatus,
    (select hi.subject from identities hi where hi.provider = 'google' and hi.user_id = h.id) as hsub
  from json_each(?1) j
  left join identities i on i.provider = 'google' and i.subject = json_extract(j.value, '$.id')
  left join users u on u.id = i.user_id
  left join users h on h.email = json_extract(j.value, '$.email')`;

// The deletion treatment, gated on the row now being removed (never the
// owner): that address's shares, the user's memberships, then the address.
const GONE =
  "exists (select 1 from users where id = ?1 and status = 'removed' and role <> 'owner')";
const DROP_SHARES = `delete from shares where ${GONE}
  and email = (select email from users where id = ?1)`;
const DROP_MEMBERSHIPS = `delete from space_members where user_id = ?1 and ${GONE}`;
const PLACEHOLDER = `update users set email = ?2 where id = ?1 and email <> ?2 and ${GONE}`;

const MOVE_EMAIL = `update users set email = ?2
  where id = ?1 and email = ?3 and status <> 'removed'
    and not exists (select 1 from users where email = ?2)`;
const MOVED = "exists (select 1 from users where id = ?1 and email = ?2)";
/**
 * The old address's shares re-keyed to the new one (shares are keyed by
 * address only; there is no user_id column): on a conflict the higher role.
 */
const COPY_SHARES = `insert into shares (artifact_id, email, role, created_by, created_at)
  select artifact_id, ?2, role, created_by, created_at from shares
  where email = ?3 and ${MOVED} and true
  on conflict (artifact_id, email) do update set role =
    case when shares.role = 'editor' or excluded.role = 'editor' then 'editor' else 'viewer' end
  where shares.role <> excluded.role and excluded.role = 'editor'`;
/** The old address's shares, once copied (the row moved). */
const DROP_OLD_SHARES = `delete from shares where email = ?3 and ${MOVED}`;

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
 * nothing. Suspensions and deletions are never held.
 */
export async function applyUsers(
  env: Env,
  page: GoogleUser[],
  o: ApplyUsersOpts,
): Promise<void> {
  const guard = o.guard ?? noGuard;
  const list = page.flatMap((u) => {
    const email = normalizeEmail(u.primaryEmail);
    return email ? [{ u, email }] : [];
  });
  if (!list.length) return;
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
    // Unknown id. Only a recycled address is handled here: a free one is
    // created by bindPage (listings), and an address held by a row without a
    // Google link is left to sign-in (P2 links it after hd verification).
    if (u.deleted || u.suspended || !r.hid || !r.hsub || r.hsub === u.id)
      continue;
    if (!domains.has(email.slice(email.lastIndexOf("@") + 1))) continue;
    if (r.howner) {
      logWarn("directory_recycled_owner_address");
      continue;
    }
    // A new directory id behind an address an old row holds: the old user
    // renamed (their row follows them), or gone (deletion treatment, which
    // also cuts that address's shares and memberships: decision 2).
    // Without users.get (no lookup) nothing is removed on this signal.
    if (!o.lookup) continue;
    const old = await o.lookup(r.hsub);
    const oldEmail =
      old && !old.deleted ? normalizeEmail(old.primaryEmail) : null;
    // Renamed and still active: the row follows its user (changeEmail cuts
    // the shares on the address they left, in the same batch). Gone, or a
    // removed row (never renamed): the deletion treatment frees the address.
    if (oldEmail && oldEmail !== email && r.hstatus !== "removed")
      await changeEmail(env, r.hid, email, oldEmail, guard);
    else await deleteUser(env, r.hid, "directory_new_id", guard, o.ctx);
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
  email: string,
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
      o.ctx,
      SYNC,
    );
  } else if (!u.suspended && r.status === "suspended") {
    guard();
    await setUserStatus(
      env,
      r.uid,
      "active",
      "directory_unsuspend",
      o.ctx,
      SYNC,
    );
  }
  if (r.email && r.email !== email)
    await changeEmail(env, r.uid, r.email, email, guard);
}

/**
 * The deletion treatment: removed (setUserStatus), then in one batch that
 * address's shares, every space membership (sync and manual) and the
 * address itself (a placeholder), then the sockets close. Never the owner
 * (setUserStatus and every statement exclude that row).
 */
export async function deleteUser(
  env: Env,
  uid: string,
  why: AuditReason,
  guard: Guard,
  ctx?: Ctx,
): Promise<void> {
  guard();
  await setUserStatus(env, uid, "removed", why, ctx, SYNC);
  // Not re-guarded: the removal committed, and deletions are never held.
  await env.DB.batch([
    stmt(env.DB, DROP_SHARES).bind(uid),
    stmt(env.DB, DROP_MEMBERSHIPS).bind(uid),
    stmt(env.DB, PLACEHOLDER).bind(uid, placeholder(uid)),
  ]);
  await revokeUserLive(env, uid, "directory delete", ctx);
}

/**
 * Moves user `uid` from address `from` to `to` (when nobody else holds it).
 * Shares follow the person: every share on `from` is re-keyed to `to` in
 * the same batch (the higher role on a conflict), every share write gated
 * on the row having moved, so they keep their access and a later holder of
 * `from` inherits nothing. Their access only stays or widens: no socket
 * needs to close.
 */
async function changeEmail(
  env: Env,
  uid: string,
  from: string,
  to: string,
  guard: Guard,
): Promise<void> {
  if (to === normalizeEmail(env.OWNER_EMAIL ?? "")) return;
  guard();
  const out = await env.DB.batch([
    stmt(env.DB, MOVE_EMAIL).bind(uid, to, from),
    stmt(env.DB, COPY_SHARES).bind(uid, to, from),
    stmt(env.DB, DROP_OLD_SHARES).bind(uid, to, from),
  ]);
  if (!out[0]?.meta.changes) logWarn("directory_email_taken");
}
