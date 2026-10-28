import { normalizeEmail } from "@oa/auth-core";
import {
  type ArtifactSummary,
  type CapReason,
  type DirectoryMode,
  directoryModeOf,
  type GroupMapping,
  LIST_SPACES_MAX,
  MANAGED_BY_ORG_MAPPING_MESSAGE,
  type ManagedByOrgMappingDetails,
  type Member,
  type MySpace,
  newId,
  type Page,
  type RestrictedGroup,
  type Role,
  SPACE_MANAGER_FIELDS,
  SPACE_MANAGER_MAPPING_ROLES,
  type Space,
  type SpaceCandidate,
  type SpaceCandidatesQuery,
  type SpaceCreate,
  type SpaceMember,
  type SpaceMemberGroup,
  type SpaceMembersPage,
  type SpaceMembersQuery,
  type SpacePatch,
  type SpaceRole,
  type SpacesQuery,
  TRANSFER_PAGE,
  type TransferInput,
  type TransferResult,
  type TransferSummary,
} from "@oa/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  authorize,
  type Caller,
  callerOf,
  capOfCaller,
  publishTarget,
  roleRankQuery,
  roleRankSql,
} from "../auth/authz.js";
import { authConfig } from "../auth/config.js";
import { canBeRestricted, capOf, isGuestRole, orgCan } from "../auth/policy.js";
import { getDb } from "../db/client.js";
import { spaces } from "../db/schema.js";
import { stmt } from "../db/stmt.js";
import { emailEnabled, sendEmail } from "../email/send.js";
import { spaceSelfAddEmail } from "../email/templates.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { logError } from "../log.js";
import {
  closeRuntimeSockets,
  MAX_CLOSE,
  revokeFanoutCap,
  revokeUserLive,
  revokeUsersLive,
} from "../runtime/revoke.js";
import { getSummary } from "./artifacts.js";
import { type AuditActor, audit, userActor } from "./audit.js";
import { kickSync } from "./directory.js";
import { getSettings, statusOf } from "./members.js";
import {
  identitiesOf,
  MEMBER_EXTRAS_COLS,
  type MemberExtrasRow,
  RESTRICTED_SYNC_FOR_GROUP,
  restrictedGroupsSql,
  restrictionOf,
} from "./restriction.js";
import { toMember } from "./users.js";

// The spaces API (P3 T9): shared spaces, their members and group mappings,
// the "Every space" org mappings, restricted groups and the manual
// restricted flag. Contract: packages/shared/src/hosted/spaces.ts. Rules:
// - 404 for no access, never 403, except the contract's space_forbidden and
//   directory_mapping_off on member and mapping changes.
// - Every mutation and its audit row commit in one D1 batch; an audit row is
//   gated in SQL on the change, so a no-op or a lost race writes none.
// - Every narrowing closes the affected users' live sockets in the same
//   request (revokeUserLive; revokeUsersLive for a group or every member).

type Ctx = Pick<ExecutionContext, "waitUntil"> | undefined;

/** The `spaces` feature: every route here is 404 without it (authz is the same either way). */
export const spacesOn = (env: Env): boolean =>
  authConfig(env).features.includes("spaces");

/** Directory sync mode from FEATURES: google (running), frozen (Team after trial) or off. */
export const directoryMode = (env: Env): DirectoryMode =>
  directoryModeOf(authConfig(env).features);

// Frozen edits (P3 T15), each in the batch of the edit, before its writes:
// (space ?1, user ?2) at ?3; ?4 = 1 for an org admin, else never a manager row
// (the guarded writes skip it too). The first reconcile after sync returns
// applies each (directory/thaw.ts).
// - An override of a synced row, recorded once (first edit wins, so
//   manual_role is the manual row from before any frozen edit; null: none):
//   the thaw puts manual_role back.
const RECORD_FROZEN_EDIT = `insert into frozen_edits (space_id, user_id, at, manual_role, kind)
  select ?1, ?2, ?3, (select role from space_members
    where space_id = ?1 and user_id = ?2 and source = 'manual'), 'override'
  where exists (select 1 from space_members
    where space_id = ?1 and user_id = ?2 and source = 'sync')
    and (?4 = 1 or not exists (select 1 from space_members
      where space_id = ?1 and user_id = ?2 and role = 'manager'))
  on conflict (space_id, user_id) do nothing`;
// - A manual write (role ?5) on a pair with no synced row, recorded once when
//   it changes the row: the thaw keeps it (and audits that).
const RECORD_FROZEN_MANUAL = `insert into frozen_edits (space_id, user_id, at, manual_role, kind)
  select ?1, ?2, ?3, null, 'manual'
  where not exists (select 1 from space_members
    where space_id = ?1 and user_id = ?2 and source = 'sync')
    and not exists (select 1 from space_members
      where space_id = ?1 and user_id = ?2 and source = 'manual' and role = ?5)
    and (?4 = 1 or not exists (select 1 from space_members
      where space_id = ?1 and user_id = ?2 and role = 'manager'))
  on conflict (space_id, user_id) do nothing`;
// - An explicit removal (?5 = 1: the synced row goes too): final, whatever
//   came before. The thaw restores no manual row for it.
const RECORD_FROZEN_DELETE = `insert into frozen_edits (space_id, user_id, at, manual_role, kind)
  select ?1, ?2, ?3, null, 'delete'
  where exists (select 1 from space_members where space_id = ?1 and user_id = ?2
    and (source = 'manual' or ?5 = 1) and (?4 = 1 or role <> 'manager'))
  on conflict (space_id, user_id) do update set kind = 'delete'`;
// - Sync live again (before the thaw ran): an admin's manual write or
//   removal supersedes the pending outcome, so the thaw can't undo it. Only
//   when the write applies (checked before it, as UPSERT_MANUAL / the delete
//   decide). The record stays so the thaw still derives the synced row again
//   (a frozen override deleted it).
//   Write: role ?3, ?4 = 1 for an org admin; the manual row is kept.
const SUPERSEDE_BY_WRITE = `update frozen_edits set kind = 'manual'
  where space_id = ?1 and user_id = ?2 and kind <> 'manual'
    and not exists (select 1 from space_members where space_id = ?1 and user_id = ?2
      and source = 'manual' and (role = ?3 or (?4 = 0 and role = 'manager')))`;
//   Removal: ?3 = 1 for an org admin; final.
const SUPERSEDE_BY_DELETE = `update frozen_edits set kind = 'delete'
  where space_id = ?1 and user_id = ?2 and kind <> 'delete'
    and exists (select 1 from space_members where space_id = ?1 and user_id = ?2
      and source = 'manual' and (?3 = 1 or role <> 'manager'))`;

const notFound = () => new ApiError("not_found", "Not found");
const personalError = (what: string) =>
  new ApiError("space_personal", `Personal spaces ${what}`);
const syncOff = () =>
  new ApiError("directory_sync_off", "Directory sync is off or frozen");
const forbidden = (target: "member" | "mapping") =>
  new ApiError(
    "space_forbidden",
    target === "member"
      ? "Only an admin can make someone a manager."
      : "Only an admin can make a group a manager.",
    { target },
  );

export function requireSpaces(env: Env): void {
  if (!spacesOn(env)) throw notFound();
}

function me(c: Caller): Member {
  if (c.kind !== "user") throw new ApiError("unauthorized", "Sign in required");
  return c.user;
}

/** An uncapped org owner or admin (orgCan's admin; a cap drops it). */
const isAdmin = (c: Caller): boolean =>
  c.kind === "user" && orgCan(c.user, "space.create", { cap: capOfCaller(c) });

const RANK: Record<SpaceRole, number> = { viewer: 1, editor: 2, manager: 3 };
const ROLES: readonly SpaceRole[] = ["viewer", "editor", "manager"];
/** A stored role, or null for anything else (fail closed). */
const knownRole = (v: unknown): SpaceRole | null =>
  ROLES.includes(v as SpaceRole) ? (v as SpaceRole) : null;
const rank = (r: SpaceRole | null | undefined): number => (r ? RANK[r] : 0);
const roleOf = (n: number): SpaceRole | null => ROLES[n - 1] ?? null;
const maxRole = (...rs: (SpaceRole | null | undefined)[]): SpaceRole | null =>
  roleOf(Math.max(0, ...rs.map(rank)));

// ------------------------------------------------------------- cursors

const b64url = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** A keyset position: values only, so a forged one can't widen what a filter shows. */
const encodeCursor = (v: (string | number)[]) => b64url(JSON.stringify(v));

function decodeCursor(
  s: string | undefined,
  shape: readonly ("string" | "number")[],
): (string | number)[] | null {
  if (s === undefined) return null;
  const bad = () =>
    new ApiError("bad_request", "Invalid cursor", {
      path: "cursor",
      reason: "invalid",
    });
  if (s.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(s)) throw bad();
  let v: unknown;
  try {
    v = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) =>
          ch.charCodeAt(0),
        ),
      ),
    );
  } catch {
    throw bad();
  }
  if (
    !Array.isArray(v) ||
    v.length !== shape.length ||
    v.some((x, i) => typeof x !== shape[i])
  )
    throw bad();
  return v as (string | number)[];
}

// -------------------------------------------------------------- spaces

const SMM_KEY = "space_manager_mappings";

/** Distinct members of every Every-space mapped group (uncorrelated). */
const EVERY_MEMBER_COUNT =
  sql.raw(`(select count(distinct dm.user_id) from org_group_mappings ogm
  join directory_members dm on dm.group_id = ogm.group_id)`);

/** The caller's view of each space row, in one statement (counts included). */
const viewCols = (c: Caller) => ({
  id: spaces.id,
  kind: spaces.kind,
  name: spaces.name,
  allMembersRole: spaces.allMembersRole,
  publicLinks: spaces.publicLinks,
  createdAt: spaces.createdAt,
  // The caller's role in a shared space: space_members, Every-space
  // mappings, allMembersRole (uncapped members): decide()'s inputs.
  rank: sql<number>`case when ${spaces.kind} = 'shared' then ${roleRankSql(c, sql`${spaces.id}`)} else 0 end`,
  // |space rows ∪ Every-space members| = (space-row users not in an
  // Every-space group) + |Every-space members|. The second term is
  // uncorrelated, so SQLite reads it once per statement; the first walks the
  // space's own rows, each probing directory_members by primary key per org
  // mapping (a handful).
  memberCount: sql<number>`case when ${spaces.kind} = 'shared' then
      (select count(distinct sm.user_id) from space_members sm where sm.space_id = ${spaces.id}
        and not exists (select 1 from org_group_mappings ogm join directory_members dm
          on dm.group_id = ogm.group_id and dm.user_id = sm.user_id))
      + ${EVERY_MEMBER_COUNT} else 1 end`,
  artifactCount: sql<number>`(select count(*) from artifacts a where a.space_id = ${spaces.id} and a.deleted_at is null)`,
  smm: sql<string | null>`(select value from settings where key = ${SMM_KEY})`,
});
type ViewRow = {
  id: string;
  kind: string;
  name: string;
  allMembersRole: string | null;
  publicLinks: number;
  createdAt: number;
  rank: number;
  memberCount: number;
  artifactCount: number;
  smm: string | null;
};

const visibleTo = (c: Caller, r: ViewRow): boolean =>
  r.kind === "shared"
    ? isAdmin(c) || r.rank > 0
    : c.kind === "user" && r.id === c.user.id;

/** The caller's role: their own personal space is manager. */
const myRoleIn = (c: Caller, r: ViewRow): SpaceRole | null =>
  r.kind === "shared"
    ? roleOf(r.rank)
    : c.kind === "user" && r.id === c.user.id
      ? "manager"
      : null;

/** Space managers may change mappings while the org setting is on (default). */
const managerMappingsOn = (v: string | null) => v !== "false";

function toSpace(c: Caller, r: ViewRow): Space {
  const shared = r.kind === "shared";
  const myRole = myRoleIn(c, r);
  const u = c.kind === "user" ? c.user : null;
  return {
    id: r.id,
    kind: shared ? "shared" : "personal",
    name: r.name,
    publicLinks: r.publicLinks === 1,
    // Only one's own personal space is ever visible.
    owner:
      !shared && u && u.id === r.id
        ? { id: u.id, email: u.email, name: u.name }
        : null,
    allMembersRole: shared ? knownRole(r.allMembersRole) : null,
    myRole,
    memberCount: r.memberCount,
    artifactCount: r.artifactCount,
    createdAt: new Date(r.createdAt).toISOString(),
    can: {
      manageMappings:
        shared &&
        (isAdmin(c) ||
          (myRole === "manager" &&
            capOfCaller(c) == null &&
            managerMappingsOn(r.smm))),
    },
  };
}

/**
 * The space as the caller sees it, or 404: unknown, deleted, someone else's
 * personal space, or a shared space where the caller has no role and is not
 * an org admin. Never says which.
 */
async function seeSpace(env: Env, c: Caller, id: string): Promise<ViewRow> {
  const [r] = await getDb(env)
    .select(viewCols(c))
    .from(spaces)
    .where(and(eq(spaces.id, id), isNull(spaces.deletedAt)))
    .limit(1);
  if (!r || !visibleTo(c, r)) throw notFound();
  return r;
}

/** GET R.space(id). */
export async function getSpace(
  env: Env,
  c: Caller,
  id: string,
): Promise<Space> {
  return toSpace(c, await seeSpace(env, c, id));
}

/**
 * GET R.spaces: the caller's personal space first, then shared spaces by
 * name. Org admins also see every shared space (myRole null where they have
 * no role). Keyset on (kind, name, id). Two statements in one batch: the
 * personal space by primary key, and shared spaces walking
 * spaces_kind_name_idx in order (no personal row is read, no sort).
 */
export async function listSpaces(
  env: Env,
  c: Caller,
  q: SpacesQuery,
): Promise<Page<Space>> {
  const u = me(c);
  const after = decodeCursor(q.cursor, ["number", "string", "string"]);
  const db = getDb(env);
  const wantPersonal = !after && q.kind !== "shared";
  const wantShared = q.kind !== "personal";
  const personal = db
    .select(viewCols(c))
    .from(spaces)
    .where(
      and(
        eq(spaces.id, u.id),
        eq(spaces.kind, "personal"),
        isNull(spaces.deletedAt),
        wantPersonal ? undefined : sql`0`,
      ),
    )
    .limit(1);
  const [, an, ai] = after ?? [];
  const shared = db
    .select(viewCols(c))
    .from(spaces)
    .where(
      and(
        eq(spaces.kind, "shared"),
        isNull(spaces.deletedAt),
        wantShared ? undefined : sql`0`,
        isAdmin(c) ? undefined : sql`${roleRankSql(c, sql`${spaces.id}`)} > 0`,
        // A cursor on the personal space (kind 0) continues from the first shared one.
        after && after[0] === 1
          ? sql`(${spaces.name} > ${an} or (${spaces.name} = ${an} and ${spaces.id} > ${ai}))`
          : undefined,
      ),
    )
    .orderBy(spaces.kind, spaces.name, spaces.id)
    .limit(q.limit + 1);
  const [mine, others] = await db.batch([personal, shared]);
  const rows = [...mine, ...others];
  const more = rows.length > q.limit;
  const page = more ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((r) => toSpace(c, r)),
    nextCursor:
      more && last
        ? encodeCursor([last.kind === "shared" ? 1 : 0, last.name, last.id])
        : null,
  };
}

/**
 * POST R.spaces (org owner, admin): one batch with its space.create row and,
 * with addMe (the default), the creator's manual manager row, audited
 * space.member.add. A manual row: directory sync never removes it.
 */
export async function createSpace(
  env: Env,
  c: Caller,
  input: SpaceCreate,
): Promise<Space> {
  const u = me(c);
  if (!orgCan(u, "space.create", { cap: capOfCaller(c) })) throw notFound();
  const id = newId();
  await env.DB.batch([
    stmt(
      env.DB,
      "insert into spaces (id, kind, name, all_members_role, public_links, created_at) values (?, 'shared', ?, ?, ?, ?)",
    ).bind(
      id,
      input.name,
      input.allMembersRole,
      input.publicLinks ? 1 : 0,
      Date.now(),
    ),
    audit(env, "space.create", { type: "space", id }, userActor(u.id), {
      spaceId: id,
      detail: {
        allMembersRole: input.allMembersRole,
        publicLinks: input.publicLinks,
      },
    }),
    ...(input.addMe
      ? [
          stmt(
            env.DB,
            "insert into space_members (space_id, user_id, role, source, created_at) values (?, ?, 'manager', 'manual', ?)",
          ).bind(id, u.id, Date.now()),
          audit(
            env,
            "space.member.add",
            { type: "user", id: u.id },
            userActor(u.id),
            { spaceId: id, detail: { role: "manager" } },
          ),
        ]
      : []),
  ]);
  return getSpace(env, c, id);
}

// Every active member allMembersRole reaches (decide: team roles, uncapped).
// Most recently seen first: past revokeUsersLive's cap, the ones most likely
// to hold a socket are signalled.
// At most ?1 rows: revokeUsersLive's cap plus one, so the Worker never reads
// more than it can signal and still sees that it truncated.
const ALL_MEMBERS = `select id from users where status = 'active'
  and role in ('owner', 'admin', 'member') and restricted_manual = 0 and restricted_sync = 0
  order by last_seen_at desc limit ?1`;

/**
 * PATCH R.space(id). name and publicLinks: the space's managers and org
 * admins; allMembersRole: org admins (anything else from a manager is 404).
 * publicLinks off only refuses NEW public links (decided): nothing is
 * rewritten and no link or socket is revoked; audited space.public_links.
 * name and allMembersRole changes are audited space.update. Lowering or
 * removing allMembersRole revokes every member it reached.
 */
export async function patchSpace(
  env: Env,
  c: Caller,
  id: string,
  patch: SpacePatch,
  ctx?: Ctx,
): Promise<Space> {
  const u = me(c);
  const r = await seeSpace(env, c, id);
  if (r.kind !== "shared") throw personalError("can't be changed");
  const keys = Object.keys(patch) as (keyof SpacePatch)[];
  const manager = orgCan(u, "space.rename", {
    spaceRole: roleOf(r.rank),
    cap: capOfCaller(c),
  });
  const allowed =
    isAdmin(c) ||
    (manager &&
      keys.every((k) =>
        (SPACE_MANAGER_FIELDS as readonly string[]).includes(k),
      ));
  if (!allowed) throw notFound();
  if (!keys.length) return toSpace(c, r);
  const name = patch.name ?? null;
  const links =
    patch.publicLinks === undefined ? null : patch.publicLinks ? 1 : 0;
  const setsAll = patch.allMembersRole !== undefined;
  const all = patch.allMembersRole ?? null;
  const fields = [
    ...(name !== null && name !== r.name ? ["name"] : []),
    ...(setsAll && all !== knownRole(r.allMembersRole)
      ? ["allMembersRole"]
      : []),
  ];
  const actor = userActor(u.id);
  const out = await env.DB.batch([
    // The old role, read in the batch (its transaction), so a concurrent
    // change can't hide a lowering.
    stmt(
      env.DB,
      "select all_members_role as old from spaces where id = ?",
    ).bind(id),
    // Before the update, each gated on the row still differing (no-op: no row).
    audit(env, "space.update", { type: "space", id }, actor, {
      spaceId: id,
      detail: { fields, ...(setsAll ? { allMembersRole: all } : {}) },
      when: {
        sql: `exists (select 1 from spaces where id = ? and ((? is not null and name <> ?)
          or (? = 1 and coalesce(all_members_role, '') <> coalesce(?, ''))))`,
        args: [id, name, name, setsAll ? 1 : 0, all],
      },
    }),
    audit(env, "space.public_links", { type: "space", id }, actor, {
      spaceId: id,
      detail: { publicLinks: patch.publicLinks },
      when: {
        sql: "? is not null and exists (select 1 from spaces where id = ? and public_links <> ?)",
        args: [links, id, links],
      },
    }),
    stmt(
      env.DB,
      `update spaces set name = coalesce(?2, name), public_links = coalesce(?3, public_links),
        all_members_role = case when ?4 = 1 then ?5 else all_members_role end
        where id = ?1 and kind = 'shared'`,
    ).bind(id, name, links, setsAll ? 1 : 0, all),
  ]);
  const old = (out[0]?.results[0] as { old: string | null } | undefined)?.old;
  if (setsAll && rank(all) < rank(knownRole(old))) {
    const { results } = await stmt(env.DB, ALL_MEMBERS)
      .bind(revokeFanoutCap(env) + 1)
      .all<{ id: string }>();
    await revokeUsersLive(
      env,
      results.map((x) => x.id),
      "space role lowered",
      ctx,
    );
  }
  return getSpace(env, c, id);
}

/**
 * DELETE R.space(id) (org owner, admin): only when the space holds no
 * artifact at all, trash included (decide() still grants on a soft-deleted
 * space's role, so trash must move or purge first). The emptiness check and
 * the delete are one statement; members and mappings cascade.
 */
export async function deleteSpace(
  env: Env,
  c: Caller,
  id: string,
): Promise<void> {
  const u = me(c);
  const r = await seeSpace(env, c, id);
  if (r.kind !== "shared") throw personalError("can't be deleted");
  if (!orgCan(u, "space.delete", { cap: capOfCaller(c) })) throw notFound();
  // Live rows on artifacts_space_live_idx, trash on artifacts_deleted_idx.
  // Plain `?` throughout: audit() appends these args to its own.
  const empty = `not exists (select 1 from artifacts where space_id = ? and deleted_at is null)
    and not exists (select 1 from artifacts where deleted_at is not null and space_id = ?)`;
  const out = await env.DB.batch([
    audit(env, "space.delete", { type: "space", id }, userActor(u.id), {
      spaceId: id,
      when: {
        sql: `exists (select 1 from spaces where id = ? and kind = 'shared') and ${empty}`,
        args: [id, id, id],
      },
    }),
    // Gated as the delete below, before its cascade drops the mappings:
    // the rows of groups only this space maps go (as DROP_UNTARGETED), so
    // mapping one elsewhere never grants from frozen rows (P2.5 #17).
    stmt(
      env.DB,
      `delete from directory_members
        where group_id in (select group_id from group_mappings where space_id = ?)
          and not exists (select 1 from group_mappings gm
            where gm.group_id = directory_members.group_id and gm.space_id <> ?)
          and not exists (select 1 from org_group_mappings o
            where o.group_id = directory_members.group_id)
          and not exists (select 1 from restricted_groups rg
            where rg.group_id = directory_members.group_id)
          and exists (select 1 from spaces where id = ? and kind = 'shared')
          and ${empty}`,
    ).bind(id, id, id, id, id),
    stmt(
      env.DB,
      `delete from spaces where id = ? and kind = 'shared' and ${empty}`,
    ).bind(id, id, id),
  ]);
  if (!out[2]?.meta.changes) {
    // Gone meanwhile (a concurrent delete): 404, not 409.
    const still = await stmt(
      env.DB,
      "select 1 from spaces where id = ? and deleted_at is null",
    )
      .bind(id)
      .first();
    if (!still) throw notFound();
    throw new ApiError(
      "space_not_empty",
      "Move or delete its artifacts first. Deleted artifacts count until the trash clears them, 30 days after deletion.",
    );
  }
}

// ------------------------------------------------------------- members

// One query shape for the member list, its total and a single row. ?1 space,
// ?2 limit, ?3 user id, ?4/?5 the q patterns, ?6 group, ?7/?8 the cursor.
// Members are users with a space_members row (manual or sync) or in an
// Every-space mapped group (never expanded into rows).
const MEMBER_SET = `with m(user_id) as (
    select sm.user_id from space_members sm where sm.space_id = ?1
    union
    select dm.user_id from org_group_mappings ogm
      join directory_members dm on dm.group_id = ogm.group_id)`;
const MEMBER_FILTER = `(?3 is null or u.id = ?3)
  and (?4 is null or u.email like ?4 escape '\\'
    or (' ' || lower(coalesce(nullif(u.display_name, ''), u.name))) like ?5 escape '\\')
  and (?6 is null or (u.id in (select dm.user_id from directory_members dm where dm.group_id = ?6)
    and (exists (select 1 from group_mappings gm where gm.space_id = ?1 and gm.group_id = ?6)
      or exists (select 1 from org_group_mappings ogm where ogm.group_id = ?6))))`;
// The page's ids first (filter, keyset, limit), then only those rows are
// decorated with their roles and groups.
const MEMBER_PAGE = `${MEMBER_SET},
  p(id, email) as (select u.id, u.email from m join users u on u.id = m.user_id
    where ${MEMBER_FILTER}
      and (?7 is null or u.email > ?7 or (u.email = ?7 and u.id > ?8))
    order by u.email, u.id limit ?2)
  select u.id, u.email, u.name, u.display_name as displayName, u.role, u.status,
    u.last_seen_at as lastSeenAt, u.restricted_manual as rm, u.restricted_sync as rs,
    ${restrictedGroupsSql("u")} as groups,
    (select sm.role from space_members sm where sm.space_id = ?1 and sm.user_id = u.id and sm.source = 'manual') as manualRole,
    (select sm.role from space_members sm where sm.space_id = ?1 and sm.user_id = u.id and sm.source = 'sync') as syncRow,
    (select json_group_array(json_object('groupId', gm.group_id, 'email', gm.group_email, 'role', gm.role))
      from group_mappings gm join directory_members dm on dm.group_id = gm.group_id and dm.user_id = u.id
      where gm.space_id = ?1) as spaceGroups,
    (select json_group_array(json_object('groupId', ogm.group_id, 'email', ogm.group_email, 'role', ogm.role))
      from org_group_mappings ogm join directory_members dm on dm.group_id = ogm.group_id and dm.user_id = u.id) as everyGroups
  from p join users u on u.id = p.id
  order by p.email, p.id`;
const MEMBER_TOTAL = `${MEMBER_SET}
  select count(*) as n from m join users u on u.id = m.user_id
  where ${MEMBER_FILTER} and ?2 is null`;

type MemberRowSql = {
  id: string;
  email: string;
  name: string;
  displayName: string | null;
  role: string;
  status: string;
  lastSeenAt: number | null;
  rm: number;
  rs: number;
  groups: string | null;
  manualRole: string | null;
  syncRow: string | null;
  spaceGroups: string | null;
  everyGroups: string | null;
};

function groupsOf(
  raw: string | null,
  via: SpaceMemberGroup["via"],
): SpaceMemberGroup[] {
  let v: unknown;
  try {
    v = JSON.parse(raw ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  return v.flatMap(
    (g: { groupId?: unknown; email?: unknown; role?: unknown }) => {
      const role = knownRole(g?.role);
      return role &&
        typeof g.groupId === "string" &&
        typeof g.email === "string"
        ? [{ groupId: g.groupId, email: g.email, name: null, role, via }]
        : [];
    },
  );
}

const capFor = (
  env: Env,
  r: { role: string; rm: number; rs: number },
): CapReason | null =>
  capOf(
    {
      role: r.role as Role,
      restrictedManual: r.rm !== 0,
      restrictedSync: r.rs !== 0,
    },
    authConfig(env),
  );

/**
 * The caller may manage this space's people (an uncapped org admin, or an
 * uncapped manager of it): only they see SpaceMember.restriction's detail.
 */
const managesSpace = (c: Caller, r: ViewRow): boolean =>
  c.kind === "user" &&
  orgCan(c.user, "space.members", {
    spaceRole: roleOf(r.rank),
    cap: capOfCaller(c),
  });

function toSpaceMember(
  env: Env,
  allMembersRole: string | null,
  r: MemberRowSql,
  /** managesSpace: the restriction's detail; anyone else gets null (cap only). */
  detail: boolean,
): SpaceMember | null {
  const manualRole = knownRole(r.manualRole);
  // Only the groups that grant syncRole (contract): a per-space mapping
  // grants through the sync row, so with none (a frozen override removed
  // or replaced it) its groups grant nothing here.
  const groups = [
    ...groupsOf(r.syncRow === null ? null : r.spaceGroups, "space"),
    ...groupsOf(r.everyGroups, "every"),
  ];
  // Per-space groups are expanded into the sync row; Every-space ones are
  // resolved here, at read time, as authz does.
  const syncRole = maxRole(
    knownRole(r.syncRow),
    ...groups.filter((g) => g.via === "every").map((g) => g.role),
  );
  const role = maxRole(manualRole, syncRole);
  if (!role) return null;
  const m = toMember(r);
  const cap = capFor(env, r);
  return {
    userId: r.id,
    user: { id: r.id, email: m.email, name: m.name },
    status: statusOf(r.status),
    role,
    source: rank(manualRole) >= rank(role) ? "manual" : "sync",
    manualRole,
    syncRole,
    groups,
    cap,
    // As decide(): allMembersRole never reaches guests or capped members.
    allMembers:
      !isGuestRole(r.role as Role) && cap === null
        ? knownRole(allMembersRole)
        : null,
    restriction: detail ? restrictionOf(r) : null,
  };
}

/** `%`, `_` and `\` matched literally in a LIKE pattern (escape '\'). */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** GET R.spaceMembers(id): members and org admins; Page plus the filtered total. */
export async function listSpaceMembers(
  env: Env,
  c: Caller,
  id: string,
  q: SpaceMembersQuery,
): Promise<SpaceMembersPage> {
  const r = await seeSpace(env, c, id);
  if (r.kind !== "shared") throw personalError("have no members");
  const after = decodeCursor(q.cursor, ["string", "string"]);
  const needle = q.q ? likeEscape(q.q.toLowerCase()) : null;
  const filter = [
    id,
    null,
    null,
    needle === null ? null : `${needle}%`,
    needle === null ? null : `% ${needle}%`,
    q.group ?? null,
  ];
  const [page, total] = await env.DB.batch([
    stmt(env.DB, MEMBER_PAGE).bind(
      id,
      q.limit + 1,
      ...filter.slice(2),
      after?.[0] ?? null,
      after?.[1] ?? null,
    ),
    stmt(env.DB, MEMBER_TOTAL).bind(...filter),
  ]);
  const rows = (page?.results ?? []) as MemberRowSql[];
  const more = rows.length > q.limit;
  const shown = more ? rows.slice(0, q.limit) : rows;
  const last = shown[shown.length - 1];
  return {
    items: shown
      .map((x) => toSpaceMember(env, r.allMembersRole, x, managesSpace(c, r)))
      .filter((x): x is SpaceMember => x !== null),
    nextCursor: more && last ? encodeCursor([last.email, last.id]) : null,
    total: (total?.results[0] as { n: number } | undefined)?.n ?? 0,
  };
}

// The add-people search (R.spaceCandidates): active org members (never
// guests), keyset (email, id). ?1 space, ?2/?3 the q patterns, ?4/?5 the
// cursor, ?6 limit. The space's rows and Every-space roles give spaceRole,
// as toSpaceMember resolves SpaceMember.role.
const CANDIDATES = `select u.id, u.email, u.name, u.display_name as displayName, u.role,
    u.last_seen_at as lastSeenAt, u.restricted_manual as rm,
    ${restrictedGroupsSql("u")} as groups,
    (select json_group_array(sm.role) from space_members sm
      where sm.space_id = ?1 and sm.user_id = u.id) as rowRoles,
    (select json_group_array(ogm.role) from org_group_mappings ogm
      join directory_members dm on dm.group_id = ogm.group_id and dm.user_id = u.id) as everyRoles
  from users u
  where u.status = 'active' and u.role in ('owner', 'admin', 'member')
    and (?2 is null or u.email like ?2 escape '\\'
      or (' ' || lower(coalesce(nullif(u.display_name, ''), u.name))) like ?3 escape '\\')
    and (?4 is null or u.email > ?4 or (u.email = ?4 and u.id > ?5))
  order by u.email, u.id limit ?6`;
type CandidateRow = {
  id: string;
  email: string;
  name: string;
  displayName: string | null;
  role: string;
  lastSeenAt: number | null;
  rm: number;
  groups: string | null;
  rowRoles: string | null;
  everyRoles: string | null;
};

const rolesIn = (raw: string | null): (SpaceRole | null)[] => {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(v) ? v.map(knownRole) : [];
  } catch {
    return [];
  }
};

/**
 * GET R.spaceCandidates(id): who a caller able to manage this space may add.
 * An uncapped org admin or an uncapped manager of the space; anyone else
 * 404 (seeSpace, then requireSpaceManager). Personal: 400 space_personal.
 * One statement, bounded by the query's limit.
 */
export async function listSpaceCandidates(
  env: Env,
  c: Caller,
  id: string,
  q: SpaceCandidatesQuery,
): Promise<Page<SpaceCandidate>> {
  const r = await seeSpace(env, c, id);
  if (r.kind !== "shared") throw personalError("have no members");
  requireSpaceManager(c, r);
  const after = decodeCursor(q.cursor, ["string", "string"]);
  const needle = q.q ? likeEscape(q.q.toLowerCase()) : null;
  const { results } = await stmt(env.DB, CANDIDATES)
    .bind(
      id,
      needle === null ? null : `${needle}%`,
      needle === null ? null : `% ${needle}%`,
      after?.[0] ?? null,
      after?.[1] ?? null,
      q.limit + 1,
    )
    .all<CandidateRow>();
  const more = results.length > q.limit;
  const shown = more ? results.slice(0, q.limit) : results;
  const last = shown[shown.length - 1];
  return {
    items: shown.map((x) => {
      const m = toMember(x);
      return {
        id: m.id,
        email: m.email,
        name: m.name,
        role: m.role,
        restriction: restrictionOf(x),
        spaceRole: maxRole(...rolesIn(x.rowRoles), ...rolesIn(x.everyRoles)),
      };
    }),
    nextCursor: more && last ? encodeCursor([last.email, last.id]) : null,
  };
}

/** Their SpaceMember view, or null when they hold no role here. */
async function memberViewOf(
  env: Env,
  spaceId: string,
  allMembersRole: string | null,
  userId: string,
): Promise<SpaceMember | null> {
  const row = await stmt(env.DB, MEMBER_PAGE)
    .bind(spaceId, 1, userId, null, null, null, null, null)
    .first<MemberRowSql>();
  // Its callers (PUT or DELETE a member, an admin's self-add) manage the space.
  return row ? toSpaceMember(env, allMembersRole, row, true) : null;
}

async function memberView(
  env: Env,
  spaceId: string,
  allMembersRole: string | null,
  userId: string,
): Promise<SpaceMember> {
  const m = await memberViewOf(env, spaceId, allMembersRole, userId);
  if (!m) throw notFound();
  return m;
}

const ROWS_OF = `select u.id, u.status,
  (select role from space_members where space_id = ?1 and user_id = u.id and source = 'manual') as manual,
  (select role from space_members where space_id = ?1 and user_id = u.id and source = 'sync') as sync,
  (select json_group_array(ogm.role) from org_group_mappings ogm
    join directory_members dm on dm.group_id = ogm.group_id and dm.user_id = u.id) as every
  from users u where u.id = ?2`;
type Rows = {
  id: string;
  status: string;
  manual: string | null;
  sync: string | null;
  /** The roles their Every space groups (org mappings) give, as JSON. */
  every: string | null;
};

/** Their Every space role: the best org mapping role over their groups. */
const everyOf = (t: Rows | null | undefined): SpaceRole | null =>
  maxRole(...rolesIn(t?.every ?? null));

/**
 * 409 managed_by_org_mapping: an Every space group gives them `everyRole`
 * here, which no change to this space's rows can remove or lower.
 */
const managedByOrgMapping = (userId: string, everyRole: SpaceRole) =>
  new ApiError("managed_by_org_mapping", MANAGED_BY_ORG_MAPPING_MESSAGE, {
    userId,
    everyRole,
  } satisfies ManagedByOrgMappingDetails);

// The manual row. A non-admin never overwrites a manager row (the handler
// refuses first; this keeps a racing promotion intact). A same-role write
// changes nothing.
const UPSERT_MANUAL = `insert into space_members (space_id, user_id, role, source, created_at)
  values (?1, ?2, ?3, 'manual', ?4)
  on conflict (space_id, user_id, source) do update set role = excluded.role
  where space_members.role <> excluded.role and (?5 = 1 or space_members.role <> 'manager')`;
// The frozen override's manual row: as UPSERT_MANUAL, but for a non-admin
// (?5 = 0) nothing at all when either row became a manager after the
// handler's check (the delete above skipped it): no half override.
const OVERRIDE_MANUAL = `insert into space_members (space_id, user_id, role, source, created_at)
  select ?1, ?2, ?3, 'manual', ?4
  where ?5 = 1 or not exists (select 1 from space_members
    where space_id = ?1 and user_id = ?2 and role = 'manager')
  on conflict (space_id, user_id, source) do update set role = excluded.role
  where space_members.role <> excluded.role and (?5 = 1 or space_members.role <> 'manager')`;
const MANUAL_ROW = `exists (select 1 from space_members where space_id = ? and user_id = ? and source = 'manual')`;

/** Manager-capable on this space (org admins, or its uncapped managers), else 404. */
function requireSpaceManager(c: Caller, r: ViewRow): Member {
  const u = me(c);
  if (
    !orgCan(u, "space.members", {
      spaceRole: roleOf(r.rank),
      cap: capOfCaller(c),
    })
  )
    throw notFound();
  return u;
}

/** The effective role from a ROWS_OF row (manual and sync rows). */
const rowsRole = (r: Rows | undefined): SpaceRole | null =>
  maxRole(knownRole(r?.manual), knownRole(r?.sync));
const rowsIn = (r: D1Result | undefined): Rows | undefined =>
  r?.results[0] as Rows | undefined;

/**
 * PUT R.spaceMember(id, userId): the manual row. A space manager (not an
 * org admin) granting manager, or changing a member who holds a manager
 * row (manual or synced; frozen override included): 403 space_forbidden
 * { target: member }. Sync frozen, on a row with a synced role: a manual
 * override (the synced row goes). Audited space.member.add /
 * space.member.role. The roles before and after are read inside the batch,
 * so a concurrent change can't hide a lowering; a lowered role revokes.
 */
export async function putSpaceMember(
  env: Env,
  c: Caller,
  id: string,
  userId: string,
  role: SpaceRole,
  ctx?: Ctx,
): Promise<SpaceMember> {
  const r = await seeSpace(env, c, id);
  if (r.kind !== "shared") throw personalError("have no members");
  const u = requireSpaceManager(c, r);
  const admin = isAdmin(c);
  const t = await stmt(env.DB, ROWS_OF).bind(id, userId).first<Rows>();
  if (t?.status !== "active") throw notFound();
  const manual = knownRole(t.manual);
  const synced = knownRole(t.sync);
  const every = everyOf(t);
  // A peer manager (by hand, synced or Every space) is an org admin's to change.
  if (
    !admin &&
    (role === "manager" ||
      manual === "manager" ||
      synced === "manager" ||
      every === "manager")
  )
    throw forbidden("member");
  // An Every space group's role is a floor, sync live or frozen: below it the
  // write could never take effect. Equal to it, with no row here, changes
  // nothing; above it is a manual grant.
  if (every && rank(role) < rank(every))
    throw managedByOrgMapping(userId, every);
  if (role === every && !manual && !synced)
    return memberView(env, id, r.allMembersRole, userId);
  const override = directoryMode(env) === "frozen" && synced !== null;
  const actor = userActor(u.id);
  const target = { type: "user", id: userId } as const;
  const a = admin ? 1 : 0;
  const out = await env.DB.batch([
    stmt(env.DB, ROWS_OF).bind(id, userId),
    ...(override
      ? [
          audit(env, "space.member.role", target, actor, {
            spaceId: id,
            detail: { syncFrozen: true, role },
            // Every override statement is void for a non-admin once either
            // row is a manager (a promotion racing the check): a loss
            // writes nothing.
            when: {
              sql: `exists (select 1 from space_members where space_id = ? and user_id = ? and source = 'sync')
                and (? = 1 or not exists (select 1 from space_members
                  where space_id = ? and user_id = ? and role = 'manager'))`,
              args: [id, userId, a, id, userId],
            },
          }),
          // Replaced by the first reconcile after sync returns (P3 T15).
          stmt(env.DB, RECORD_FROZEN_EDIT).bind(id, userId, Date.now(), a),
          stmt(
            env.DB,
            `delete from space_members where space_id = ?1 and user_id = ?2 and source = 'sync'
              and (?3 = 1 or not exists (select 1 from space_members
                where space_id = ?1 and user_id = ?2 and role = 'manager'))`,
          ).bind(id, userId, a),
          stmt(env.DB, OVERRIDE_MANUAL).bind(id, userId, role, Date.now(), a),
        ]
      : [
          audit(env, "space.member.add", target, actor, {
            spaceId: id,
            detail: { role },
            when: { sql: `not ${MANUAL_ROW}`, args: [id, userId] },
          }),
          audit(env, "space.member.role", target, actor, {
            spaceId: id,
            detail: { role },
            when: {
              sql: `exists (select 1 from space_members where space_id = ? and user_id = ?
                and source = 'manual' and role <> ? and (? = 1 or role <> 'manager'))`,
              args: [id, userId, role, a],
            },
          }),
          ...(directoryMode(env) === "frozen"
            ? [
                stmt(env.DB, RECORD_FROZEN_MANUAL).bind(
                  id,
                  userId,
                  Date.now(),
                  a,
                  role,
                ),
              ]
            : [stmt(env.DB, SUPERSEDE_BY_WRITE).bind(id, userId, role, a)]),
          stmt(env.DB, UPSERT_MANUAL).bind(id, userId, role, Date.now(), a),
        ]),
    stmt(env.DB, ROWS_OF).bind(id, userId),
  ]);
  const after = rowsIn(out.at(-1));
  // The guarded writes refused: a manager row (manual or synced) appeared
  // after the check, and a non-admin can't change a peer manager. Nothing
  // was written or audited.
  if (knownRole(after?.manual) !== role) throw forbidden("member");
  if (rank(rowsRole(after)) < rank(rowsRole(rowsIn(out[0]))))
    await revokeUserLive(env, userId, "space role lowered", ctx);
  return memberView(env, id, r.allMembersRole, userId);
}

/**
 * DELETE R.spaceMember(id, userId): removes the manual row. A space manager
 * (not an org admin) removing a peer manager (a manager row, manual or
 * synced): 403 space_forbidden { target: member }. A synced-only row while
 * sync is live: 409 member_synced. Sync frozen: the synced row goes too
 * (removing access is always allowed). Audited space.member.remove; the
 * member's live sockets close when their role dropped (read in the batch).
 */
export async function deleteSpaceMember(
  env: Env,
  c: Caller,
  id: string,
  userId: string,
  ctx?: Ctx,
): Promise<SpaceMember | null> {
  const r = await seeSpace(env, c, id);
  if (r.kind !== "shared") throw personalError("have no members");
  const u = requireSpaceManager(c, r);
  const admin = isAdmin(c);
  const t = await stmt(env.DB, ROWS_OF).bind(id, userId).first<Rows>();
  const manual = knownRole(t?.manual);
  const synced = knownRole(t?.sync);
  const every = everyOf(t);
  if (!manual && !synced && !every) throw notFound();
  if (
    !admin &&
    (manual === "manager" || synced === "manager" || every === "manager")
  )
    throw forbidden("member");
  // Only an Every space group puts them here: nothing of this space's to
  // remove, sync live or frozen.
  if (!manual && !synced && every) throw managedByOrgMapping(userId, every);
  const mode = directoryMode(env);
  const both = mode === "frozen" && synced !== null;
  if (!manual && !both) {
    if (mode === "google")
      throw new ApiError(
        "member_synced",
        "This person comes from a Google group. Remove them from the group in Google, or change their role here.",
      );
    throw notFound();
  }
  const a = admin ? 1 : 0;
  // The rows this removes: the manual one, plus the synced one when frozen;
  // never a manager row for a non-admin (a racing promotion stays).
  const rows = `space_id = ? and user_id = ? and (source = 'manual' or ? = 1)
    and (? = 1 or role <> 'manager')`;
  const args = [id, userId, both ? 1 : 0, a];
  const out = await env.DB.batch([
    stmt(env.DB, ROWS_OF).bind(id, userId),
    audit(
      env,
      "space.member.remove",
      { type: "user", id: userId },
      userActor(u.id),
      {
        spaceId: id,
        ...(both ? { detail: { syncFrozen: true } } : {}),
        when: {
          sql: `exists (select 1 from space_members where ${rows})`,
          args,
        },
      },
    ),
    // Frozen: an explicit removal is final; the thaw only derives the synced
    // row again from fresh membership (P3 T15).
    ...(mode === "frozen"
      ? [
          stmt(env.DB, RECORD_FROZEN_DELETE).bind(
            id,
            userId,
            Date.now(),
            a,
            both ? 1 : 0,
          ),
        ]
      : [stmt(env.DB, SUPERSEDE_BY_DELETE).bind(id, userId, a)]),
    stmt(env.DB, `delete from space_members where ${rows}`).bind(...args),
    stmt(env.DB, ROWS_OF).bind(id, userId),
  ]);
  if (!out.at(-2)?.meta.changes) {
    // Refused (a racing manager row, non-admin): 403, as the check would
    // have said; else the rows were already gone.
    const now = rowsIn(out.at(-1));
    if (
      !admin &&
      (knownRole(now?.manual) === "manager" ||
        (both && knownRole(now?.sync) === "manager"))
    )
      throw forbidden("member");
    throw notFound();
  }
  const after = rowsIn(out.at(-1));
  if (rank(rowsRole(after)) < rank(rowsRole(rowsIn(out[0]))))
    await revokeUserLive(env, userId, "removed from space", ctx);
  // Still here (an Every space group's role, or a live synced row): the role
  // they keep.
  return maxRole(rowsRole(after), everyOf(after))
    ? memberViewOf(env, id, r.allMembersRole, userId)
    : null;
}

/**
 * POST R.spaceMemberSelf(id): an org owner or admin adds themselves to a
 * shared space (personal: 400 space_personal). Audited
 * space.admin_self_add; the space's managers are emailed (best effort).
 */
export async function selfAddSpace(
  env: Env,
  c: Caller,
  id: string,
  role: SpaceRole,
  ctx?: Ctx,
): Promise<SpaceMember> {
  const u = me(c);
  if (!orgCan(u, "space.adminSelfAdd", { cap: capOfCaller(c) }))
    throw notFound();
  const s = await stmt(
    env.DB,
    "select kind, name, all_members_role as allMembersRole from spaces where id = ? and deleted_at is null",
  )
    .bind(id)
    .first<{ kind: string; name: string; allMembersRole: string | null }>();
  if (!s) throw notFound();
  if (s.kind !== "shared")
    throw personalError(
      "can't be joined: admins add themselves to shared spaces only",
    );
  const out = await env.DB.batch([
    stmt(env.DB, ROWS_OF).bind(id, u.id),
    audit(
      env,
      "space.admin_self_add",
      { type: "user", id: u.id },
      userActor(u.id),
      {
        spaceId: id,
        detail: { role },
        when: {
          sql: "not exists (select 1 from space_members where space_id = ? and user_id = ? and source = 'manual' and role = ?)",
          args: [id, u.id, role],
        },
      },
    ),
    stmt(env.DB, UPSERT_MANUAL).bind(id, u.id, role, Date.now(), 1),
    stmt(env.DB, ROWS_OF).bind(id, u.id),
  ]);
  const before = rowsIn(out[0]);
  if (rank(rowsRole(rowsIn(out[3]))) < rank(rowsRole(before)))
    await revokeUserLive(env, u.id, "space role lowered", ctx);
  if (knownRole(before?.manual) !== role)
    await notifyManagers(env, u, id, s.name, role, ctx);
  return memberView(env, id, s.allMembersRole, u.id);
}

/** The space's active managers (manual or synced), other than the admin. */
const MANAGERS = `select u.email from users u where u.status = 'active' and u.id <> ?2
  and u.id in (select user_id from space_members where space_id = ?1 and role = 'manager')
  order by u.email limit 50`;

async function notifyManagers(
  env: Env,
  admin: Member,
  spaceId: string,
  spaceName: string,
  role: SpaceRole,
  ctx?: Ctx,
): Promise<void> {
  if (!emailEnabled(env)) return;
  const run = (async () => {
    const { results } = await stmt(env.DB, MANAGERS)
      .bind(spaceId, admin.id)
      .all<{ email: string }>();
    if (!results.length) return;
    const instance = (await getSettings(env)).name;
    await Promise.all(
      results.map((m) =>
        sendEmail(
          env,
          admin.id,
          m.email,
          () =>
            spaceSelfAddEmail({
              admin: admin.name || admin.email,
              instance,
              recipient: m.email,
              appHost: env.APP_HOST,
              space: spaceName,
              role,
            }),
          { kind: "space", instance },
        ),
      ),
    );
  })().catch((e) => logError("space_notify_failed", e));
  if (ctx) ctx.waitUntil(run);
  else await run;
}

// ------------------------------------------------------------ mappings

// A per-space mapping change re-derives the synced rows of the group's
// members in that space (the max over the space's mappings they belong to),
// as the reconcile does, so the change applies now and not at the next sync.
const RESYNC_DELETE = `delete from space_members where space_id = ?1 and source = 'sync'
  and user_id in (select user_id from directory_members where group_id = ?2)`;
// Never a removed user (as apply.ts SYNC_ADD): a directory deletion keeps
// its directory_members rows, and a mapping must not hand them a row.
const RESYNC_INSERT = `insert into space_members (space_id, user_id, role, source, created_at)
  select ?1, dm.user_id,
    case max(case gm.role when 'manager' then 3 when 'editor' then 2 when 'viewer' then 1 else 0 end)
      when 3 then 'manager' when 2 then 'editor' else 'viewer' end,
    'sync', ?3
  from directory_members dm join group_mappings gm on gm.group_id = dm.group_id and gm.space_id = ?1
  join users u on u.id = dm.user_id and u.status <> 'removed'
  where dm.user_id in (select user_id from directory_members where group_id = ?2)
  group by dm.user_id`;
/**
 * A group that is no longer a target (mapped per space or Every space, or
 * restricted) loses its directory_members rows: sync stops reading it, so
 * they would go stale, and a later mapping would grant access from them.
 * Mapped again, it starts empty until sync reads it (P2.5 #17). Runs after
 * every statement that still reads them (the re-derive, the revoke list).
 */
export const DROP_UNTARGETED = `delete from directory_members where group_id = ?1
  and not exists (select 1 from group_mappings where group_id = ?1)
  and not exists (select 1 from org_group_mappings where group_id = ?1)
  and not exists (select 1 from restricted_groups where group_id = ?1)`;
// Active members only (the others hold no socket), most recently seen first.
// At most ?2 rows (revokeUsersLive's cap plus one), as ALL_MEMBERS.
const GROUP_MEMBERS = `select u.id from directory_members dm join users u on u.id = dm.user_id
  where dm.group_id = ?1 and u.status = 'active' order by u.last_seen_at desc limit ?2`;
// A restricted group's members who can be restricted: owners and admins
// never are (restrict_admin), so they don't use up the revoke cap.
const RESTRICTABLE_MEMBERS = `select u.id from directory_members dm join users u on u.id = dm.user_id
  where dm.group_id = ?1 and u.status = 'active' and u.role not in ('owner', 'admin')
  order by u.last_seen_at desc limit ?2`;
const GROUP_OF = `select (select role from group_mappings where space_id = ?1 and group_id = ?2) as cur,
  (select email from directory_groups where group_id = ?2) as email,
  (select count(*) from directory_members where group_id = ?2) as n`;

const MAP_ROLE =
  "select role from group_mappings where space_id = ? and group_id = ?";
const ORG_MAP_ROLE = "select role from org_group_mappings where group_id = ?";

const MANAGER_ROLES: readonly string[] = SPACE_MANAGER_MAPPING_ROLES;

/**
 * The per-space mapping gate (contract order): not visible 404; personal
 * 400 space_personal; neither an org admin nor the space's uncapped manager
 * 404; a manager's PUT while spaceManagerMappings is off 403
 * directory_mapping_off. Returns whether the caller is an org admin.
 */
async function mappingGate(
  env: Env,
  c: Caller,
  id: string,
  op: "list" | "put" | "remove",
): Promise<{ admin: boolean; actor: AuditActor }> {
  const r = await seeSpace(env, c, id);
  if (r.kind !== "shared") throw personalError("have no mappings");
  const u = me(c);
  const admin = isAdmin(c);
  if (
    !admin &&
    !orgCan(u, "space.mappings.manage", {
      spaceRole: roleOf(r.rank),
      cap: capOfCaller(c),
    })
  )
    throw notFound();
  if (!admin && op === "put" && !managerMappingsOn(r.smm))
    throw new ApiError(
      "directory_mapping_off",
      "Space managers can't change group mappings on this install",
    );
  return { admin, actor: userActor(u.id) };
}

/** GET R.spaceMappings(id): the space's own rows (Every-space rows are R.orgMappings). */
export async function listSpaceMappings(
  env: Env,
  c: Caller,
  id: string,
): Promise<GroupMapping[]> {
  await mappingGate(env, c, id, "list");
  const { results } = await stmt(
    env.DB,
    `select gm.group_id as groupId, gm.group_email as email, gm.role,
      case when exists (select 1 from directory_groups dg where dg.group_id = gm.group_id)
        then (select count(*) from directory_members dm where dm.group_id = gm.group_id) end as n
      from group_mappings gm where gm.space_id = ? order by gm.group_email, gm.group_id`,
  )
    .bind(id)
    .all<{ groupId: string; email: string; role: string; n: number | null }>();
  return results.flatMap((m) => {
    const role = knownRole(m.role);
    return role ? [mapping(m.groupId, m.email, role, m.n)] : [];
  });
}

const mapping = (
  groupId: string,
  email: string,
  role: SpaceRole,
  memberCount: number | null,
): GroupMapping => ({
  groupId,
  email,
  name: null,
  role,
  memberCount,
  lastSyncedAt: null,
});

/**
 * PUT R.spaceMapping(id, groupId). After the gate: a manager role (the body
 * or the existing row) from a space manager 403 space_forbidden { target:
 * mapping }; sync off or frozen 409; an unknown group 404. Audited
 * mapping.set; a lowered role revokes the group's members.
 */
export async function putSpaceMapping(
  env: Env,
  c: Caller,
  id: string,
  groupId: string,
  role: SpaceRole,
  ctx?: Ctx,
): Promise<GroupMapping> {
  const { admin, actor } = await mappingGate(env, c, id, "put");
  const g = await stmt(env.DB, GROUP_OF)
    .bind(id, groupId)
    .first<{ cur: string | null; email: string | null; n: number }>();
  const cur = knownRole(g?.cur);
  if (!admin && [role, cur].some((x) => x && !MANAGER_ROLES.includes(x)))
    throw forbidden("mapping");
  if (directoryMode(env) !== "google") throw syncOff();
  if (!g?.email) throw notFound();
  const now = Date.now();
  const out = await env.DB.batch([
    // The role before and after, inside the batch: a concurrent change
    // can't hide a lowering.
    stmt(env.DB, MAP_ROLE).bind(id, groupId),
    audit(env, "mapping.set", { type: "mapping", id: groupId }, actor, {
      spaceId: id,
      detail: { role },
      // Not when the write below refuses (a racing manager row, non-admin).
      when: {
        sql: `not exists (select 1 from group_mappings where space_id = ? and group_id = ? and role = ?)
          and (? = 1 or not exists (select 1 from group_mappings
            where space_id = ? and group_id = ? and role = 'manager'))`,
        args: [id, groupId, role, admin ? 1 : 0, id, groupId],
      },
    }),
    stmt(
      env.DB,
      `insert into group_mappings (space_id, group_id, group_email, role) values (?1, ?2, ?3, ?4)
        on conflict (space_id, group_id) do update set role = excluded.role, group_email = excluded.group_email
        where ?5 = 1 or group_mappings.role <> 'manager'`,
    ).bind(id, groupId, g.email, role, admin ? 1 : 0),
    stmt(env.DB, RESYNC_DELETE).bind(id, groupId),
    stmt(env.DB, RESYNC_INSERT).bind(id, groupId, now),
    stmt(env.DB, GROUP_MEMBERS).bind(groupId, revokeFanoutCap(env) + 1),
    stmt(env.DB, MAP_ROLE).bind(id, groupId),
  ]);
  const after = roleIn(out[6]);
  // The guarded write refused: the row became a manager mapping after the
  // check (a non-admin can't touch it). Nothing changed, nothing audited.
  if (after !== role) throw forbidden("mapping");
  if (rank(after) < rank(roleIn(out[0])))
    await revokeUsersLive(env, idsOf(out[5]), "space mapping lowered", ctx);
  // A new or changed mapping reads the group's members now, not at the next
  // reconcile; an unchanged PUT kicks nothing (no load from repeated writes).
  if (roleIn(out[0]) !== after) await kickSync(env, "mapping", ctx);
  return mapping(groupId, g.email, after, g.n);
}

const idsOf = (r: D1Result | undefined): string[] =>
  ((r?.results ?? []) as { id: string }[]).map((x) => x.id);
/** The role a MAP_ROLE / ORG_MAP_ROLE read found (null: no row). */
const roleIn = (r: D1Result | undefined): SpaceRole | null =>
  knownRole((r?.results[0] as { role?: unknown } | undefined)?.role);

/**
 * DELETE R.spaceMapping(id, groupId). After the gate: no row 404; a manager
 * row from a space manager 403 space_forbidden; sync off or frozen 409.
 * Audited mapping.remove; the group's members' synced rows are re-derived
 * and their live sockets close.
 */
export async function deleteSpaceMapping(
  env: Env,
  c: Caller,
  id: string,
  groupId: string,
  ctx?: Ctx,
): Promise<void> {
  const { admin, actor } = await mappingGate(env, c, id, "remove");
  const g = await stmt(env.DB, GROUP_OF)
    .bind(id, groupId)
    .first<{ cur: string | null }>();
  const cur = knownRole(g?.cur);
  if (!cur) throw notFound();
  if (!admin && !MANAGER_ROLES.includes(cur)) throw forbidden("mapping");
  if (directoryMode(env) !== "google") throw syncOff();
  const out = await env.DB.batch([
    audit(env, "mapping.remove", { type: "mapping", id: groupId }, actor, {
      spaceId: id,
      // Exactly the row the delete below removes.
      when: {
        sql: `exists (select 1 from group_mappings where space_id = ? and group_id = ?
          and (? = 1 or role <> 'manager'))`,
        args: [id, groupId, admin ? 1 : 0],
      },
    }),
    stmt(
      env.DB,
      `delete from group_mappings where space_id = ? and group_id = ?
        and (? = 1 or role <> 'manager')`,
    ).bind(id, groupId, admin ? 1 : 0),
    stmt(env.DB, RESYNC_DELETE).bind(id, groupId),
    stmt(env.DB, RESYNC_INSERT).bind(id, groupId, Date.now()),
    stmt(env.DB, GROUP_MEMBERS).bind(groupId, revokeFanoutCap(env) + 1),
    stmt(env.DB, MAP_ROLE).bind(id, groupId),
    stmt(env.DB, DROP_UNTARGETED).bind(groupId),
  ]);
  if (!out[1]?.meta.changes) {
    // Refused (raced to a manager mapping, non-admin) or already gone.
    if (roleIn(out[5])) throw forbidden("mapping");
    throw notFound();
  }
  await revokeUsersLive(env, idsOf(out[4]), "space mapping removed", ctx);
}

// ----------------------------------------------- Every-space mappings

const ORG_PAGE = `select ogm.group_id as groupId, ogm.group_email as email, ogm.role,
    case when exists (select 1 from directory_groups dg where dg.group_id = ogm.group_id)
      then (select count(*) from directory_members dm where dm.group_id = ogm.group_id) end as n
  from org_group_mappings ogm
  where (?2 is null or ogm.group_email > ?2 or (ogm.group_email = ?2 and ogm.group_id > ?3))
  order by ogm.group_email, ogm.group_id limit ?1`;

/** GET R.orgMappings (org owner, admin): one row per group, never per space. */
export async function listOrgMappings(
  env: Env,
  cursor: string | undefined,
  limit: number,
): Promise<Page<GroupMapping>> {
  const after = decodeCursor(cursor, ["string", "string"]);
  const { results } = await stmt(env.DB, ORG_PAGE)
    .bind(limit + 1, after?.[0] ?? null, after?.[1] ?? null)
    .all<{ groupId: string; email: string; role: string; n: number | null }>();
  const more = results.length > limit;
  const rows = more ? results.slice(0, limit) : results;
  const last = rows[rows.length - 1];
  return {
    items: rows.flatMap((m) => {
      const role = knownRole(m.role);
      return role ? [mapping(m.groupId, m.email, role, m.n)] : [];
    }),
    nextCursor: more && last ? encodeCursor([last.email, last.groupId]) : null,
  };
}

const ORG_GROUP_OF = `select (select email from directory_groups where group_id = ?1) as email,
  (select count(*) from directory_members where group_id = ?1) as n`;

/**
 * PUT R.orgMapping(groupId) (org owner, admin): one org_group_mappings row,
 * applied at read time to every shared space (later ones too), never to a
 * personal space and never expanded into per-space rows. Sync off or
 * frozen 409; unknown group 404. Audited mapping.set (scope org); a lowered
 * role revokes the group's members.
 */
export async function putOrgMapping(
  env: Env,
  actor: Member,
  groupId: string,
  role: SpaceRole,
  ctx?: Ctx,
): Promise<GroupMapping> {
  if (directoryMode(env) !== "google") throw syncOff();
  const g = await stmt(env.DB, ORG_GROUP_OF)
    .bind(groupId)
    .first<{ cur: string | null; email: string | null; n: number }>();
  if (!g?.email) throw notFound();
  const out = await env.DB.batch([
    stmt(env.DB, ORG_MAP_ROLE).bind(groupId),
    audit(
      env,
      "mapping.set",
      { type: "mapping", id: groupId },
      userActor(actor.id),
      {
        spaceId: null,
        detail: { scope: "org", role },
        when: {
          sql: "not exists (select 1 from org_group_mappings where group_id = ? and role = ?)",
          args: [groupId, role],
        },
      },
    ),
    stmt(
      env.DB,
      `insert into org_group_mappings (group_id, group_email, role) values (?1, ?2, ?3)
        on conflict (group_id) do update set role = excluded.role, group_email = excluded.group_email`,
    ).bind(groupId, g.email, role),
    stmt(env.DB, GROUP_MEMBERS).bind(groupId, revokeFanoutCap(env) + 1),
    stmt(env.DB, ORG_MAP_ROLE).bind(groupId),
  ]);
  if (rank(roleIn(out[4])) < rank(roleIn(out[0])))
    await revokeUsersLive(
      env,
      idsOf(out[3]),
      "every-space mapping lowered",
      ctx,
    );
  if (roleIn(out[0]) !== roleIn(out[4])) await kickSync(env, "mapping", ctx);
  return mapping(groupId, g.email, role, g.n);
}

/** DELETE R.orgMapping(groupId): sync off or frozen 409; no row 404; audited; the group's members are revoked. */
export async function deleteOrgMapping(
  env: Env,
  actor: Member,
  groupId: string,
  ctx?: Ctx,
): Promise<void> {
  if (directoryMode(env) !== "google") throw syncOff();
  const out = await env.DB.batch([
    audit(
      env,
      "mapping.remove",
      { type: "mapping", id: groupId },
      userActor(actor.id),
      {
        spaceId: null,
        detail: { scope: "org" },
        when: {
          sql: "exists (select 1 from org_group_mappings where group_id = ?)",
          args: [groupId],
        },
      },
    ),
    stmt(env.DB, "delete from org_group_mappings where group_id = ?").bind(
      groupId,
    ),
    stmt(env.DB, GROUP_MEMBERS).bind(groupId, revokeFanoutCap(env) + 1),
    stmt(env.DB, DROP_UNTARGETED).bind(groupId),
  ]);
  if (!out[1]?.meta.changes) throw notFound();
  await revokeUsersLive(env, idsOf(out[2]), "every-space mapping removed", ctx);
}

// --------------------------------------------------------- restrictions

const RESTRICTED_LIST = `select rg.group_id as groupId, rg.group_email as email, rg.created_at as createdAt,
    case when exists (select 1 from directory_groups dg where dg.group_id = rg.group_id)
      then (select count(*) from directory_members dm where dm.group_id = rg.group_id) end as n
  from restricted_groups rg where (?1 is null or rg.group_id = ?1)
  order by rg.group_email, rg.group_id`;
type RestrictedRow = {
  groupId: string;
  email: string;
  createdAt: number | null;
  n: number | null;
};
const toRestricted = (r: RestrictedRow): RestrictedGroup => ({
  groupId: r.groupId,
  email: r.email,
  name: null,
  memberCount: r.n,
  createdAt: new Date(r.createdAt ?? 0).toISOString(),
});

/** GET R.restrictedGroups (org owner, admin). */
export async function listRestrictedGroups(
  env: Env,
): Promise<RestrictedGroup[]> {
  const { results } = await stmt(env.DB, RESTRICTED_LIST)
    .bind(null)
    .all<RestrictedRow>();
  return results.map(toRestricted);
}

/**
 * PUT R.restrictedGroup(groupId): sync off or frozen 409; unknown group
 * 404. The group's members are capped at viewer now (restricted_sync) and
 * their live sockets close. Audited restricted.set when newly added.
 */
export async function putRestrictedGroup(
  env: Env,
  actor: Member,
  groupId: string,
  ctx?: Ctx,
): Promise<RestrictedGroup> {
  if (directoryMode(env) !== "google") throw syncOff();
  const g = await stmt(
    env.DB,
    "select email from directory_groups where group_id = ?",
  )
    .bind(groupId)
    .first<{ email: string }>();
  if (!g) throw notFound();
  const out = await env.DB.batch([
    stmt(
      env.DB,
      "insert or ignore into restricted_groups (group_id, group_email, created_at) values (?, ?, ?)",
    ).bind(groupId, g.email, Date.now()),
    audit(
      env,
      "restricted.set",
      { type: "group", id: groupId },
      userActor(actor.id),
      {
        when: { sql: "changes() > 0", args: [] },
      },
    ),
    stmt(env.DB, RESTRICTED_SYNC_FOR_GROUP).bind(groupId),
    stmt(env.DB, RESTRICTABLE_MEMBERS).bind(groupId, revokeFanoutCap(env) + 1),
    stmt(env.DB, RESTRICTED_LIST).bind(groupId),
  ]);
  await revokeUsersLive(env, idsOf(out[3]), "restricted", ctx);
  // Only a newly restricted group needs its members read now.
  if ((out[0]?.meta.changes ?? 0) > 0) await kickSync(env, "mapping", ctx);
  const row = out[4]?.results[0] as RestrictedRow | undefined;
  if (!row) throw notFound();
  return toRestricted(row);
}

/**
 * DELETE R.restrictedGroup(groupId), in any mode (it lifts a frozen
 * restriction): no row 404. A widening, so nothing is revoked. Audited
 * restricted.remove.
 */
export async function deleteRestrictedGroup(
  env: Env,
  actor: Member,
  groupId: string,
): Promise<void> {
  const out = await env.DB.batch([
    audit(
      env,
      "restricted.remove",
      { type: "group", id: groupId },
      userActor(actor.id),
      {
        when: {
          sql: "exists (select 1 from restricted_groups where group_id = ?)",
          args: [groupId],
        },
      },
    ),
    stmt(env.DB, "delete from restricted_groups where group_id = ?").bind(
      groupId,
    ),
    stmt(env.DB, RESTRICTED_SYNC_FOR_GROUP).bind(groupId),
    stmt(env.DB, DROP_UNTARGETED).bind(groupId),
  ]);
  if (!out[1]?.meta.changes) throw notFound();
}

const MEMBER_WITH_RESTRICTION = `select users.id, users.email, users.name,
    users.display_name as displayName, users.role, users.status,
    users.last_seen_at as lastSeenAt, ${MEMBER_EXTRAS_COLS}
  from users where users.id = ?`;

/**
 * PUT/DELETE R.memberRestricted(id) (org owner, admin): the manual flag, in
 * any sync mode. Owners and admins can't be restricted (400 restrict_admin).
 * DELETE never lifts a group restriction. Audited restricted.set /
 * restricted.remove; setting it closes the member's live sockets.
 */
export async function setMemberRestricted(
  env: Env,
  actor: Member,
  userId: string,
  on: boolean,
  ctx?: Ctx,
): Promise<Member> {
  const t = await stmt(env.DB, "select role from users where id = ?")
    .bind(userId)
    .first<{ role: string }>();
  if (!t) throw notFound();
  if (on && !canBeRestricted(t.role as Role))
    throw new ApiError(
      "restrict_admin",
      "Owners and admins can't be restricted",
    );
  const v = on ? 1 : 0;
  const out = await env.DB.batch([
    stmt(
      env.DB,
      `update users set restricted_manual = ?2 where id = ?1 and restricted_manual <> ?2
        and (?2 = 0 or role not in ('owner', 'admin'))`,
    ).bind(userId, v),
    audit(
      env,
      on ? "restricted.set" : "restricted.remove",
      { type: "user", id: userId },
      userActor(actor.id),
      { when: { sql: "changes() > 0", args: [] } },
    ),
    stmt(env.DB, MEMBER_WITH_RESTRICTION).bind(userId),
  ]);
  if (on) await revokeUserLive(env, userId, "restricted", ctx);
  const row = out[2]?.results[0] as
    | (Parameters<typeof toMember>[0] & { status: string } & MemberExtrasRow)
    | undefined;
  if (!row) throw notFound();
  // As GET R.members reads it: null when neither the flag nor a group applies.
  return {
    ...toMember(row),
    status: statusOf(row.status),
    identities: identitiesOf(row),
    restriction: restrictionOf(row),
  };
}

// ------------------------------------------------- move and transfer (T10)

const conflict = () =>
  new ApiError("conflict", "The artifact changed while moving; try again");
const invalidSuccessor = () =>
  new ApiError(
    "invalid_successor",
    "Pick an active member who isn't a guest or restricted",
  );

/**
 * A valid successor (transfer target): an active member, admin or owner who
 * is not restricted. Guests never are, whatever authConfig says. `?n` names
 * the user id parameter.
 */
const SUCCESSOR = (n: number) =>
  `exists (select 1 from users where id = ?${n} and status = 'active'
    and role in ('owner', 'admin', 'member') and restricted_manual = 0 and restricted_sync = 0)`;

async function isSuccessor(env: Env, userId: string): Promise<boolean> {
  const r = await stmt(env.DB, `select ${SUCCESSOR(1)} as ok`)
    .bind(userId)
    .first<{ ok: number }>();
  return r?.ok === 1;
}

const isLive = async (env: Env, id: string): Promise<boolean> =>
  !!(await stmt(
    env.DB,
    "select 1 from artifacts where id = ? and deleted_at is null",
  )
    .bind(id)
    .first());

/**
 * POST R.moveArtifact(id): `can(level, "move")` on the artifact (404) and
 * orgCan("space.publish") in the target (publishTarget: 404, 400
 * space_personal for any personal space, 403 space_forbidden). One batch:
 * the compare-and-set move (#484: the space and visibility it was checked
 * against, and the target's public-links value it read, else 409) and its
 * artifact.move row. A public artifact moved into a space with public links
 * off becomes team in the same write. Then the artifact's sockets close
 * (anonymous data and events included): the source space's members and any
 * public viewers may have lost it. owner_id and updated_at are kept.
 */
export async function moveArtifact(
  env: Env,
  user: Member,
  id: string,
  toSpaceId: string,
  ctx?: Ctx,
): Promise<ArtifactSummary> {
  const who = callerOf(user);
  const { artifact: a } = await authorize(env, who, id, "move");
  const to = await publishTarget(env, who, toSpaceId, "move");
  if (a.spaceId === to.id) return getSummary(env, who, id);
  const rewrite = a.visibility === "public" && !to.publicLinks;
  // The roles the move was allowed under, re-checked in the write: editor or
  // manager in the target, and manager of a shared source (a personal source
  // is the caller's own: the space_id check already pins it).
  const target = roleRankQuery(env, who, to.id);
  const source = roleRankQuery(env, who, a.spaceId ?? "");
  const own = a.spaceId === user.id ? 1 : 0;
  const out = await env.DB.batch([
    env.DB.prepare(
      `update artifacts set space_id = ?, visibility = ?
        where id = ? and deleted_at is null and space_id is ? and visibility = ?
          and exists (select 1 from spaces where id = ? and kind = 'shared'
            and deleted_at is null and public_links = ?)
          and ${target.sql} >= 2
          and (? = 1 or ${source.sql} = 3)`,
    ).bind(
      to.id,
      rewrite ? "team" : a.visibility,
      id,
      a.spaceId,
      a.visibility,
      to.id,
      to.publicLinks ? 1 : 0,
      ...target.params,
      own,
      ...source.params,
    ),
    audit(env, "artifact.move", { type: "artifact", id }, userActor(user.id), {
      spaceId: to.id,
      detail: {
        from: a.spaceId,
        to: to.id,
        ...(rewrite ? { visibility: { from: "public", to: "team" } } : {}),
      },
      when: { sql: "changes() > 0", args: [] },
    }),
  ]);
  if (!out[0]?.meta.changes)
    throw (await isLive(env, id)) ? conflict() : notFound();
  await closeRuntimeSockets(env, [id], "artifact moved", ctx);
  return getSummary(env, who, id);
}

/**
 * POST R.transferArtifact(id): the personal owner only (`can(level,
 * "transfer")`: owner level, personal, uncapped; managers and everyone else
 * 404). The successor must be an active, non-guest, non-restricted member
 * other than the caller (400 invalid_successor). One batch: the
 * compare-and-set move into the successor's personal space (owner_id and
 * space_id; the successor re-checked in SQL), an editor share for the former
 * owner, and the artifact.transfer row, each gated on the one before. The
 * former owner drops from owner to editor on this one artifact, so its
 * sockets close (closeRuntimeSockets; revoking the user would close their
 * sockets on every other artifact too).
 */
export async function transferArtifact(
  env: Env,
  user: Member,
  id: string,
  toUserId: string,
  ctx?: Ctx,
): Promise<ArtifactSummary> {
  const who = callerOf(user);
  const { artifact: a } = await authorize(env, who, id, "transfer");
  if (toUserId === user.id || !(await isSuccessor(env, toUserId)))
    throw invalidSuccessor();
  const email = normalizeEmail(user.email) ?? user.email;
  // After the move, the share writes are gated on the artifact now being
  // the successor's (only its owner could have put it there).
  const theirs =
    "exists (select 1 from artifacts where id = ?1 and owner_id = ?2 and space_id = ?2)";
  const out = await env.DB.batch([
    stmt(
      env.DB,
      `update artifacts set owner_id = ?1, space_id = ?1
        where id = ?2 and deleted_at is null and space_id = ?3 and owner_id = ?3
          and ${SUCCESSOR(1)}`,
    ).bind(toUserId, id, user.id),
    audit(
      env,
      "artifact.transfer",
      { type: "artifact", id },
      userActor(user.id),
      {
        spaceId: toUserId,
        detail: { from: a.spaceId, to: toUserId },
        when: { sql: "changes() > 0", args: [] },
      },
    ),
    stmt(
      env.DB,
      `insert into shares (artifact_id, email, role, created_by, created_at)
        select ?1, ?3, 'editor', ?4, ?5 where ${theirs}
        on conflict (artifact_id, email) do update set role = 'editor'`,
    ).bind(id, toUserId, email, user.id, Date.now()),
    // The successor owns it now: their own share is redundant.
    stmt(
      env.DB,
      `delete from shares where artifact_id = ?1
        and email = (select email from users where id = ?2) and ${theirs}`,
    ).bind(id, toUserId),
  ]);
  if (!out[0]?.meta.changes) {
    if (!(await isSuccessor(env, toUserId))) throw invalidSuccessor();
    throw (await isLive(env, id)) ? conflict() : notFound();
  }
  await closeRuntimeSockets(env, [id], "artifact transferred", ctx);
  return getSummary(env, who, id);
}

// A departed person's artifacts: their personal space, live (on
// artifacts_space_live_idx) and trash (on artifacts_owner_deleted_idx; a
// personal space's artifacts are its owner's).
const DEPARTED_COUNTS = `select
    (select count(*) from artifacts where space_id = ?1 and deleted_at is null) as live,
    (select count(*) from artifacts where owner_id = ?1 and deleted_at is not null and space_id = ?1) as deleted`;
const DEPARTED_PAGE = `select id, visibility from artifacts where space_id = ?1 and deleted_at is null
  union all select id, visibility from artifacts where owner_id = ?1 and deleted_at is not null and space_id = ?1
  limit ?2`;
type Counts = { live: number; deleted: number };

const memberActive = () =>
  new ApiError(
    "member_active",
    "Suspend or remove the member before transferring their artifacts",
  );

/**
 * GET R.memberTransfer(id) (org owner, admin): counts only, never titles.
 * 409 member_active for an active member, like transferPersonal.
 */
export async function transferSummary(
  env: Env,
  fromUserId: string,
): Promise<TransferSummary> {
  const [u, c] = await env.DB.batch([
    stmt(env.DB, "select status from users where id = ?").bind(fromUserId),
    stmt(env.DB, DEPARTED_COUNTS).bind(fromUserId),
  ]);
  const from = u?.results[0] as { status: string } | undefined;
  if (!from) throw notFound();
  if (statusOf(from.status) === "active") throw memberActive();
  const r = c?.results[0] as Counts | undefined;
  return { live: r?.live ?? 0, deleted: r?.deleted ?? 0 };
}

/** A continuation marker (b64url); its content is never trusted. */
const TRANSFER_CURSOR = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * POST R.memberTransfer(id) (org owner, admin): moves the next page of a
 * suspended or removed member's personal artifacts (trash included) to a
 * successor's personal space (owner_id too) or a shared space. 409
 * member_active for an active source; 400 invalid_successor for a bad user
 * target (the source included); 400 space_personal or 404 for a bad space
 * target. Each call takes the next TRANSFER_PAGE rows still in the departed
 * space, so the cursor is only a continuation marker and a forged one moves
 * no more. Into a space with public links off, public artifacts become team
 * in the same batch and their sockets close; such a page is at most
 * MAX_CLOSE so every close fits the request.
 *
 * Revocation: the source is already inactive (setUserStatus revoked their
 * live access), and this narrows it on up to a page of artifacts, so their
 * presence is revoked again (one call, belt and braces); the artifacts
 * rewritten to team close their sockets. One artifact.transfer row per call,
 * on the user, gated on the move.
 */
export async function transferPersonal(
  env: Env,
  actor: Member,
  fromUserId: string,
  input: TransferInput,
  ctx?: Ctx,
): Promise<TransferResult> {
  if (input.cursor !== undefined && !TRANSFER_CURSOR.test(input.cursor))
    throw new ApiError("bad_request", "Invalid cursor", {
      path: "cursor",
      reason: "invalid",
    });
  const from = await stmt(env.DB, "select status from users where id = ?")
    .bind(fromUserId)
    .first<{ status: string }>();
  if (!from) throw notFound();
  if (statusOf(from.status) === "active") throw memberActive();
  let spaceId: string;
  let ownerId: string;
  let publicLinks = true;
  if (input.to.kind === "user") {
    const to = input.to.userId;
    if (to === fromUserId || !(await isSuccessor(env, to)))
      throw invalidSuccessor();
    spaceId = to;
    ownerId = to;
  } else {
    const s = await stmt(
      env.DB,
      "select kind, public_links as publicLinks from spaces where id = ? and deleted_at is null",
    )
      .bind(input.to.spaceId)
      .first<{ kind: string; publicLinks: number }>();
    if (!s) throw notFound();
    if (s.kind !== "shared")
      throw personalError("can't take a departed member's artifacts");
    spaceId = input.to.spaceId;
    ownerId = fromUserId;
    publicLinks = s.publicLinks === 1;
  }
  const page = publicLinks ? TRANSFER_PAGE : Math.min(TRANSFER_PAGE, MAX_CLOSE);
  const { results } = await stmt(env.DB, DEPARTED_PAGE)
    .bind(fromUserId, page)
    .all<{ id: string; visibility: string }>();
  if (!results.length) return { moved: 0, remaining: 0, nextCursor: null };
  const ids = JSON.stringify(results.map((r) => r.id));
  const pub = JSON.stringify(
    results.filter((r) => r.visibility === "public").map((r) => r.id),
  );
  // One statement, re-checking in SQL what was read: each row is still in
  // the departed space (two admins racing move each artifact once), the
  // target space still exists with the public-links value read (a personal
  // one always qualifies), and a user target is still a valid successor.
  // Into a space with public links off, public rows become team in the same
  // write.
  const move = stmt(
    env.DB,
    `update artifacts set space_id = ?3, owner_id = ?4,
        visibility = case when ?5 = 0 and visibility = 'public' then 'team' else visibility end
      where id in (select value from json_each(?1)) and space_id = ?2 and owner_id = ?2
        and exists (select 1 from spaces where id = ?3 and deleted_at is null
          and (kind = 'personal' or public_links = ?5))
        and (?6 = 0 or ${SUCCESSOR(4)})
        and exists (select 1 from users where id = ?2 and status <> 'active')
      returning id`,
  ).bind(
    ids,
    fromUserId,
    spaceId,
    ownerId,
    publicLinks ? 1 : 0,
    input.to.kind === "user" ? 1 : 0,
  );
  const out = await env.DB.batch([
    move,
    // Right after the move: moved is its changes(); teamed counts the rows
    // read as public that are now team in the target.
    audit(
      env,
      "artifact.transfer",
      { type: "user", id: fromUserId },
      userActor(actor.id),
      {
        spaceId,
        detail: { to: { kind: input.to.kind, id: spaceId } },
        detailSql: {
          sql: `json_object('moved', changes(), 'teamed', (select count(*) from artifacts
            where id in (select value from json_each(?)) and space_id = ? and visibility = 'team'))`,
          args: [publicLinks ? "[]" : pub, spaceId],
        },
        when: { sql: "changes() > 0", args: [] },
      },
    ),
    stmt(env.DB, DEPARTED_COUNTS).bind(fromUserId),
  ]);
  const moved = out[0]?.meta.changes ?? 0;
  const counts = out[2]?.results[0] as Counts | undefined;
  const remaining = (counts?.live ?? 0) + (counts?.deleted ?? 0);
  // Nothing moved while rows remain: the target changed under us.
  if (!moved && remaining > 0)
    throw new ApiError(
      "conflict",
      "The transfer target changed; check it and try again",
    );
  if (moved) {
    await revokeUserLive(env, fromUserId, "artifacts transferred", ctx);
    // Public links off: every moved row may have been public (a page is at
    // most MAX_CLOSE), so all of them close.
    if (!publicLinks) {
      const movedIds = ((out[0]?.results ?? []) as { id: string }[]).map(
        (r) => r.id,
      );
      await closeRuntimeSockets(env, movedIds, "access changed", ctx);
    }
  }
  return {
    moved,
    remaining,
    nextCursor: remaining > 0 ? encodeCursor([remaining]) : null,
  };
}

/**
 * MCP list_spaces: the spaces the caller can publish into. Their personal
 * space (orgCan artifact.create), then shared spaces where orgCan
 * space.publish holds (editor or manager, uncapped), by name, at most
 * LIST_SPACES_MAX. Empty for a capped caller. One batch of two statements.
 */
export async function publishableSpaces(
  env: Env,
  c: Caller,
): Promise<MySpace[]> {
  const u = me(c);
  const cap = capOfCaller(c);
  if (!orgCan(u, "artifact.create", { cap })) return [];
  // Without the spaces feature only the personal space is offered.
  const withShared = spacesOn(env);
  const db = getDb(env);
  const rank = roleRankSql(c, sql`${spaces.id}`);
  const cols = {
    id: spaces.id,
    name: spaces.name,
    publicLinks: spaces.publicLinks,
    rank,
  };
  const [mine, shared] = await db.batch([
    db
      .select(cols)
      .from(spaces)
      .where(
        and(
          eq(spaces.id, u.id),
          eq(spaces.kind, "personal"),
          isNull(spaces.deletedAt),
        ),
      )
      .limit(1),
    db
      .select(cols)
      .from(spaces)
      .where(
        and(
          eq(spaces.kind, "shared"),
          isNull(spaces.deletedAt),
          withShared ? undefined : sql`0`,
          sql`${rank} >= 2`,
        ),
      )
      .orderBy(spaces.kind, spaces.name, spaces.id)
      .limit(LIST_SPACES_MAX),
  ]);
  const out: MySpace[] = mine.map((r) => ({
    id: r.id,
    kind: "personal",
    name: r.name,
    publicLinks: true,
    myRole: "manager",
  }));
  for (const r of shared) {
    const role = roleOf(r.rank);
    if (role && orgCan(u, "space.publish", { spaceRole: role, cap }))
      out.push({
        id: r.id,
        kind: "shared",
        name: r.name,
        publicLinks: r.publicLinks === 1,
        myRole: role,
      });
  }
  return out.slice(0, LIST_SPACES_MAX);
}

/**
 * GET /me `spaces`: the shared spaces where the caller has a role (rank >= 1,
 * roleRankSql, so a cap drops allMembersRole), by name, at most
 * LIST_SPACES_MAX. Empty without the spaces feature. One statement.
 */
export async function mySharedSpaces(env: Env, c: Caller): Promise<MySpace[]> {
  if (c.kind !== "user" || !spacesOn(env)) return [];
  const rank = roleRankSql(c, sql`${spaces.id}`);
  const rows = await getDb(env)
    .select({
      id: spaces.id,
      name: spaces.name,
      publicLinks: spaces.publicLinks,
      rank,
    })
    .from(spaces)
    .where(
      and(
        eq(spaces.kind, "shared"),
        isNull(spaces.deletedAt),
        sql`${rank} >= 1`,
      ),
    )
    .orderBy(spaces.name, spaces.id)
    .limit(LIST_SPACES_MAX);
  const out: MySpace[] = [];
  for (const r of rows) {
    const role = roleOf(r.rank);
    if (role)
      out.push({
        id: r.id,
        kind: "shared",
        name: r.name,
        publicLinks: r.publicLinks === 1,
        myRole: role,
      });
  }
  return out;
}
