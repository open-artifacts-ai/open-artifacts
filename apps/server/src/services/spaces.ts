import {
  type CapReason,
  type DirectoryMode,
  type GroupMapping,
  type GroupRef,
  type Member,
  type MemberStatus,
  newId,
  type Page,
  type RestrictedGroup,
  type Role,
  SPACE_MANAGER_FIELDS,
  SPACE_MANAGER_MAPPING_ROLES,
  type Space,
  type SpaceCreate,
  type SpaceMember,
  type SpaceMemberGroup,
  type SpaceMembersPage,
  type SpaceMembersQuery,
  type SpacePatch,
  type SpaceRole,
  type SpacesQuery,
} from "@oa/shared";
import { and, eq, isNull, or, type SQL, sql } from "drizzle-orm";
import {
  type Caller,
  capOfCaller,
  roleRankSql,
} from "../auth/authz.js";
import { authConfig } from "../auth/config.js";
import { capOf, orgCan } from "../auth/policy.js";
import { getDb } from "../db/client.js";
import { spaces } from "../db/schema.js";
import { stmt } from "../db/stmt.js";
import { emailEnabled, sendEmail } from "../email/send.js";
import { spaceSelfAddEmail } from "../email/templates.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { logError } from "../log.js";
import { revokeUserLive, revokeUsersLive } from "../runtime/revoke.js";
import { type AuditActor, audit, userActor } from "./audit.js";
import { getSettings } from "./members.js";
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
export function directoryMode(env: Env): DirectoryMode {
  const f = authConfig(env).features;
  if (f.includes("sync_google")) return "google";
  if (f.includes("sync_frozen")) return "frozen";
  return "off";
}

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
const STATUSES: readonly MemberStatus[] = ["active", "suspended", "removed"];
const statusOf = (v: unknown): MemberStatus =>
  STATUSES.includes(v as MemberStatus) ? (v as MemberStatus) : "suspended";

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
  memberCount: sql<number>`case when ${spaces.kind} = 'shared' then (select count(*) from (
      select sm.user_id from space_members sm where sm.space_id = ${spaces.id}
      union select dm.user_id from org_group_mappings ogm
        join directory_members dm on dm.group_id = ogm.group_id)) else 1 end`,
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
export async function getSpace(env: Env, c: Caller, id: string): Promise<Space> {
  return toSpace(c, await seeSpace(env, c, id));
}

/**
 * GET R.spaces: the caller's personal space first, then shared spaces by
 * name. Org admins also see every shared space (myRole null where they have
 * no role). Keyset on (kind, name, id).
 */
export async function listSpaces(
  env: Env,
  c: Caller,
  q: SpacesQuery,
): Promise<Page<Space>> {
  const u = me(c);
  const after = decodeCursor(q.cursor, ["number", "string", "string"]);
  const k = sql<number>`(case when ${spaces.kind} = 'shared' then 1 else 0 end)`;
  const shared = isAdmin(c)
    ? eq(spaces.kind, "shared")
    : and(
        eq(spaces.kind, "shared"),
        sql`${roleRankSql(c, sql`${spaces.id}`)} > 0`,
      );
  const where: (SQL | undefined)[] = [
    isNull(spaces.deletedAt),
    q.kind ? eq(spaces.kind, q.kind) : undefined,
    or(and(eq(spaces.kind, "personal"), eq(spaces.id, u.id)), shared),
  ];
  if (after) {
    const [ak, an, ai] = after;
    where.push(
      sql`(${k} > ${ak} or (${k} = ${ak} and (${spaces.name} > ${an} or (${spaces.name} = ${an} and ${spaces.id} > ${ai}))))`,
    );
  }
  const rows = await getDb(env)
    .select(viewCols(c))
    .from(spaces)
    .where(and(...where))
    .orderBy(k, spaces.name, spaces.id)
    .limit(q.limit + 1);
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

/** POST R.spaces (org owner, admin): one batch with its space.create row. */
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
  ]);
  return getSpace(env, c, id);
}

// Every active member allMembersRole reaches (decide: team roles, uncapped).
const ALL_MEMBERS = `select id from users where status = 'active'
  and role in ('owner', 'admin', 'member') and restricted_manual = 0 and restricted_sync = 0`;

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
  const lowered = setsAll && rank(all) < rank(knownRole(r.allMembersRole));
  const out = await env.DB.batch([
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
    stmt(env.DB, lowered ? ALL_MEMBERS : "select null as id where 0"),
  ]);
  if (lowered) {
    const ids = (out[3]?.results as { id: string }[] | undefined) ?? [];
    await revokeUsersLive(
      env,
      ids.map((x) => x.id),
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
    stmt(
      env.DB,
      `delete from spaces where id = ? and kind = 'shared' and ${empty}`,
    ).bind(id, id, id),
  ]);
  if (!out[1]?.meta.changes)
    throw new ApiError(
      "space_not_empty",
      "Move or delete its artifacts first, trash included",
    );
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
const MEMBER_PAGE = `${MEMBER_SET}
  select u.id, u.email, u.name, u.display_name as displayName, u.role, u.status,
    u.last_seen_at as lastSeenAt, u.restricted_manual as rm, u.restricted_sync as rs,
    (select sm.role from space_members sm where sm.space_id = ?1 and sm.user_id = u.id and sm.source = 'manual') as manualRole,
    (select sm.role from space_members sm where sm.space_id = ?1 and sm.user_id = u.id and sm.source = 'sync') as syncRow,
    (select json_group_array(json_object('groupId', gm.group_id, 'email', gm.group_email, 'role', gm.role))
      from group_mappings gm join directory_members dm on dm.group_id = gm.group_id and dm.user_id = u.id
      where gm.space_id = ?1) as spaceGroups,
    (select json_group_array(json_object('groupId', ogm.group_id, 'email', ogm.group_email, 'role', ogm.role))
      from org_group_mappings ogm join directory_members dm on dm.group_id = ogm.group_id and dm.user_id = u.id) as everyGroups
  from m join users u on u.id = m.user_id
  where ${MEMBER_FILTER}
    and (?7 is null or u.email > ?7 or (u.email = ?7 and u.id > ?8))
  order by u.email, u.id limit ?2`;
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
  return v.flatMap((g: { groupId?: unknown; email?: unknown; role?: unknown }) => {
    const role = knownRole(g?.role);
    return role && typeof g.groupId === "string" && typeof g.email === "string"
      ? [{ groupId: g.groupId, email: g.email, name: null, role, via }]
      : [];
  });
}

const capFor = (
  env: Env,
  r: { role: string; rm: number; rs: number },
): CapReason | null =>
  capOf(
    { role: r.role as Role, restrictedManual: r.rm !== 0, restrictedSync: r.rs !== 0 },
    authConfig(env),
  );

function toSpaceMember(
  env: Env,
  allMembersRole: string | null,
  r: MemberRowSql,
): SpaceMember | null {
  const manualRole = knownRole(r.manualRole);
  const groups = [
    ...groupsOf(r.spaceGroups, "space"),
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
      r.role !== "guest" && cap === null ? knownRole(allMembersRole) : null,
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
      .map((x) => toSpaceMember(env, r.allMembersRole, x))
      .filter((x): x is SpaceMember => x !== null),
    nextCursor: more && last ? encodeCursor([last.email, last.id]) : null,
    total: (total?.results[0] as { n: number } | undefined)?.n ?? 0,
  };
}

async function memberView(
  env: Env,
  spaceId: string,
  allMembersRole: string | null,
  userId: string,
): Promise<SpaceMember> {
  const row = await stmt(env.DB, MEMBER_PAGE)
    .bind(spaceId, 1, userId, null, null, null, null, null)
    .first<MemberRowSql>();
  const m = row && toSpaceMember(env, allMembersRole, row);
  if (!m) throw notFound();
  return m;
}

const ROWS_OF = `select u.id, u.status,
  (select role from space_members where space_id = ?1 and user_id = u.id and source = 'manual') as manual,
  (select role from space_members where space_id = ?1 and user_id = u.id and source = 'sync') as sync
  from users u where u.id = ?2`;
type Rows = {
  id: string;
  status: string;
  manual: string | null;
  sync: string | null;
};

// The manual row. A non-admin never overwrites a manager row (the handler
// refuses first; this keeps a racing promotion intact). A same-role write
// changes nothing.
const UPSERT_MANUAL = `insert into space_members (space_id, user_id, role, source, created_at)
  values (?1, ?2, ?3, 'manual', ?4)
  on conflict (space_id, user_id, source) do update set role = excluded.role
  where space_members.role <> excluded.role and (?5 = 1 or space_members.role <> 'manager')`;
const MANUAL_ROW = `exists (select 1 from space_members where space_id = ? and user_id = ? and source = 'manual')`;
const SYNC_ROW = `exists (select 1 from space_members where space_id = ? and user_id = ? and source = 'sync')`;

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

/**
 * PUT R.spaceMember(id, userId): the manual row. A space manager (not an
 * org admin) granting manager, or changing a member whose manual role is
 * manager: 403 space_forbidden { target: member }. Sync frozen, on a row with
 * a synced role: a manual override (the synced row goes). Audited
 * space.member.add / space.member.role; a lowered effective role revokes.
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
  if (!t || t.status !== "active") throw notFound();
  const manual = knownRole(t.manual);
  const synced = knownRole(t.sync);
  if (!admin && (role === "manager" || manual === "manager"))
    throw forbidden("member");
  const override = directoryMode(env) === "frozen" && synced !== null;
  const actor = userActor(u.id);
  const target = { type: "user", id: userId } as const;
  await env.DB.batch(
    override
      ? [
          audit(env, "space.member.role", target, actor, {
            spaceId: id,
            detail: { syncFrozen: true, role },
            when: { sql: SYNC_ROW, args: [id, userId] },
          }),
          stmt(
            env.DB,
            "delete from space_members where space_id = ? and user_id = ? and source = 'sync'",
          ).bind(id, userId),
          stmt(env.DB, UPSERT_MANUAL).bind(id, userId, role, Date.now(), 1),
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
              args: [id, userId, role, admin ? 1 : 0],
            },
          }),
          stmt(env.DB, UPSERT_MANUAL).bind(
            id,
            userId,
            role,
            Date.now(),
            admin ? 1 : 0,
          ),
        ],
  );
  const before = maxRole(manual, synced);
  const after = override ? role : maxRole(role, synced);
  if (rank(after) < rank(before))
    await revokeUserLive(env, userId, "space role lowered", ctx);
  return memberView(env, id, r.allMembersRole, userId);
}

/**
 * DELETE R.spaceMember(id, userId): removes the manual row. A synced-only
 * row while sync is live: 409 member_synced. Sync frozen: the synced row
 * goes too (removing access is always allowed). Audited space.member.remove;
 * the member's live sockets close when their role dropped.
 */
export async function deleteSpaceMember(
  env: Env,
  c: Caller,
  id: string,
  userId: string,
  ctx?: Ctx,
): Promise<void> {
  const r = await seeSpace(env, c, id);
  if (r.kind !== "shared") throw personalError("have no members");
  const u = requireSpaceManager(c, r);
  const t = await stmt(env.DB, ROWS_OF).bind(id, userId).first<Rows>();
  const manual = knownRole(t?.manual);
  const synced = knownRole(t?.sync);
  if (!manual && !synced) throw notFound();
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
  const out = await env.DB.batch([
    audit(
      env,
      "space.member.remove",
      { type: "user", id: userId },
      userActor(u.id),
      {
        spaceId: id,
        ...(both ? { detail: { syncFrozen: true } } : {}),
        when: { sql: both ? `(${MANUAL_ROW} or ${SYNC_ROW})` : MANUAL_ROW, args: both ? [id, userId, id, userId] : [id, userId] },
      },
    ),
    stmt(
      env.DB,
      `delete from space_members where space_id = ? and user_id = ?
        and (source = 'manual' or ? = 1)`,
    ).bind(id, userId, both ? 1 : 0),
  ]);
  if (!out[1]?.meta.changes) throw notFound();
  const after = both ? null : synced;
  if (rank(after) < rank(maxRole(manual, synced)))
    await revokeUserLive(env, userId, "removed from space", ctx);
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
    throw personalError("can't be joined: admins add themselves to shared spaces only");
  const t = await stmt(env.DB, ROWS_OF).bind(id, u.id).first<Rows>();
  const manual = knownRole(t?.manual);
  const synced = knownRole(t?.sync);
  await env.DB.batch([
    audit(env, "space.admin_self_add", { type: "user", id: u.id }, userActor(u.id), {
      spaceId: id,
      detail: { role },
      when: {
        sql: "not exists (select 1 from space_members where space_id = ? and user_id = ? and source = 'manual' and role = ?)",
        args: [id, u.id, role],
      },
    }),
    stmt(env.DB, UPSERT_MANUAL).bind(id, u.id, role, Date.now(), 1),
  ]);
  if (rank(maxRole(role, synced)) < rank(maxRole(manual, synced)))
    await revokeUserLive(env, u.id, "space role lowered", ctx);
  if (manual !== role) await notifyManagers(env, u, id, s.name, role, ctx);
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
          { kind: "space" },
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
const RESYNC_INSERT = `insert into space_members (space_id, user_id, role, source, created_at)
  select ?1, dm.user_id,
    case max(case gm.role when 'manager' then 3 when 'editor' then 2 when 'viewer' then 1 else 0 end)
      when 3 then 'manager' when 2 then 'editor' else 'viewer' end,
    'sync', ?3
  from directory_members dm join group_mappings gm on gm.group_id = dm.group_id and gm.space_id = ?1
  where dm.user_id in (select user_id from directory_members where group_id = ?2)
  group by dm.user_id`;
const GROUP_MEMBERS = "select user_id as id from directory_members where group_id = ?";
const GROUP_OF = `select (select role from group_mappings where space_id = ?1 and group_id = ?2) as cur,
  (select email from directory_groups where group_id = ?2) as email,
  (select count(*) from directory_members where group_id = ?2) as n`;

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
    audit(env, "mapping.set", { type: "mapping", id: groupId }, actor, {
      spaceId: id,
      detail: { role },
      when: {
        sql: "not exists (select 1 from group_mappings where space_id = ? and group_id = ? and role = ?)",
        args: [id, groupId, role],
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
    stmt(env.DB, GROUP_MEMBERS).bind(groupId),
  ]);
  if (cur && rank(role) < rank(cur))
    await revokeUsersLive(env, idsOf(out[4]), "space mapping lowered", ctx);
  return mapping(groupId, g.email, role, g.n);
}

const idsOf = (r: D1Result | undefined): string[] =>
  ((r?.results ?? []) as { id: string }[]).map((x) => x.id);

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
      when: {
        sql: "exists (select 1 from group_mappings where space_id = ? and group_id = ?)",
        args: [id, groupId],
      },
    }),
    stmt(
      env.DB,
      `delete from group_mappings where space_id = ? and group_id = ?
        and (? = 1 or role <> 'manager')`,
    ).bind(id, groupId, admin ? 1 : 0),
    stmt(env.DB, RESYNC_DELETE).bind(id, groupId),
    stmt(env.DB, RESYNC_INSERT).bind(id, groupId, Date.now()),
    stmt(env.DB, GROUP_MEMBERS).bind(groupId),
  ]);
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

const ORG_GROUP_OF = `select (select role from org_group_mappings where group_id = ?1) as cur,
  (select email from directory_groups where group_id = ?1) as email,
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
  const cur = knownRole(g.cur);
  const out = await env.DB.batch([
    audit(env, "mapping.set", { type: "mapping", id: groupId }, userActor(actor.id), {
      spaceId: null,
      detail: { scope: "org", role },
      when: {
        sql: "not exists (select 1 from org_group_mappings where group_id = ? and role = ?)",
        args: [groupId, role],
      },
    }),
    stmt(
      env.DB,
      `insert into org_group_mappings (group_id, group_email, role) values (?1, ?2, ?3)
        on conflict (group_id) do update set role = excluded.role, group_email = excluded.group_email`,
    ).bind(groupId, g.email, role),
    stmt(env.DB, GROUP_MEMBERS).bind(groupId),
  ]);
  if (cur && rank(role) < rank(cur))
    await revokeUsersLive(env, idsOf(out[2]), "every-space mapping lowered", ctx);
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
    audit(env, "mapping.remove", { type: "mapping", id: groupId }, userActor(actor.id), {
      spaceId: null,
      detail: { scope: "org" },
      when: {
        sql: "exists (select 1 from org_group_mappings where group_id = ?)",
        args: [groupId],
      },
    }),
    stmt(env.DB, "delete from org_group_mappings where group_id = ?").bind(
      groupId,
    ),
    stmt(env.DB, GROUP_MEMBERS).bind(groupId),
  ]);
  if (!out[1]?.meta.changes) throw notFound();
  await revokeUsersLive(env, idsOf(out[2]), "every-space mapping removed", ctx);
}

// --------------------------------------------------------- restrictions

// restricted_sync for a group's members: set while they are in any
// restricted group; owners and admins are never restricted (restrict_admin).
const RESTRICT_RECOMPUTE = `update users set restricted_sync = case
    when role in ('owner', 'admin') then 0
    when exists (select 1 from directory_members dm join restricted_groups rg on rg.group_id = dm.group_id
      where dm.user_id = users.id) then 1
    else 0 end
  where id in (select user_id from directory_members where group_id = ?1)`;

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
    audit(env, "restricted.set", { type: "group", id: groupId }, userActor(actor.id), {
      when: { sql: "changes() > 0", args: [] },
    }),
    stmt(env.DB, RESTRICT_RECOMPUTE).bind(groupId),
    stmt(env.DB, GROUP_MEMBERS).bind(groupId),
    stmt(env.DB, RESTRICTED_LIST).bind(groupId),
  ]);
  await revokeUsersLive(env, idsOf(out[3]), "restricted", ctx);
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
    audit(env, "restricted.remove", { type: "group", id: groupId }, userActor(actor.id), {
      when: {
        sql: "exists (select 1 from restricted_groups where group_id = ?)",
        args: [groupId],
      },
    }),
    stmt(env.DB, "delete from restricted_groups where group_id = ?").bind(
      groupId,
    ),
    stmt(env.DB, RESTRICT_RECOMPUTE).bind(groupId),
  ]);
  if (!out[1]?.meta.changes) throw notFound();
}

const MEMBER_WITH_RESTRICTION = `select u.id, u.email, u.name, u.display_name as displayName, u.role,
    u.status, u.last_seen_at as lastSeenAt, u.restricted_manual as rm,
    (select json_group_array(json_object('groupId', rg.group_id, 'email', rg.group_email))
      from restricted_groups rg join directory_members dm on dm.group_id = rg.group_id and dm.user_id = u.id) as groups
  from users u where u.id = ?`;

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
  if (on && (t.role === "owner" || t.role === "admin"))
    throw new ApiError("restrict_admin", "Owners and admins can't be restricted");
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
    | (Parameters<typeof toMember>[0] & {
        status: string;
        rm: number;
        groups: string | null;
      })
    | undefined;
  if (!row) throw notFound();
  let groups: GroupRef[] = [];
  try {
    const v = JSON.parse(row.groups ?? "[]") as { groupId: string; email: string }[];
    groups = v.map((g) => ({ groupId: g.groupId, email: g.email, name: null }));
  } catch {}
  return {
    ...toMember(row),
    status: statusOf(row.status),
    restriction: { manual: row.rm !== 0, groups },
  };
}
