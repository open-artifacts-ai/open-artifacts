import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeEmail } from "@oa/auth-core";
import {
  type AccessLevel,
  type CapReason,
  type ListQuery,
  type Member,
  type SpaceRole,
  type Visibility,
  VisibilitySchema,
} from "@oa/shared";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Context } from "hono";
import { getDb } from "../db/client.js";
import {
  artifacts,
  directoryMembers,
  orgGroupMappings,
  shares,
  spaceMembers,
  spaces,
} from "../db/schema.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import {
  type CanCtx,
  can,
  decide,
  isTeamRole,
  type PolicyAction,
  TEAM_ROLES,
} from "./policy.js";

/** Roles that see `team` artifacts (defined in policy.ts). */
export { TEAM_ROLES };

export type Caller =
  | {
      kind: "user";
      user: Member;
      /** Guest or restricted cap (P2 authConfig, P3 restriction); absent = none. */
      cap?: CapReason | null;
    }
  | { kind: "anonymous" };
export type ArtifactRow = typeof artifacts.$inferSelect;

// "manager" (hosted M1 contract) is never produced yet; P3 sets its semantics.
const RANK: Record<AccessLevel, number> = {
  viewer: 1,
  editor: 2,
  manager: 3,
  owner: 3,
};

/**
 * The caller's cap travels on the Member object itself, under a symbol key:
 * copies (`{ ...user }`) keep it, JSON and zod output never show it. Whoever
 * loads a user for a request (session, PAT, OAuth, MCP) sets it with
 * `withCap`; every Caller is built by `callerOf`, never a literal.
 */
export const CAP: unique symbol = Symbol("oa.cap");
export type CappedMember = Member & { [CAP]?: CapReason | null };

/** Marks `m` with its cap (null = uncapped) and returns it. */
export function withCap<M extends Member>(m: M, cap: CapReason | null): M {
  (m as CappedMember)[CAP] = cap;
  return m;
}

/** The one way to build a Caller: carries the member's cap. */
export function callerOf(m: Member | null | undefined): Caller {
  if (!m) return { kind: "anonymous" };
  // Fail closed: a member that didn't come through getUser (a response-only
  // toMember) has no known cap and must never become a caller.
  if (!(CAP in m)) throw new Error("member without cap");
  return { kind: "user", user: m, cap: (m as CappedMember)[CAP] ?? null };
}

export function caller(c: Context<AppEnv>): Caller {
  return callerOf(c.var.user);
}

/** The signed-in user, or 401. */
export function requireUser(c: Context<AppEnv>): Member {
  const user = c.var.user;
  if (!user) throw new ApiError("unauthorized", "Sign in required");
  return user;
}

const callerEmail = (u: Member) => normalizeEmail(u.email);

/**
 * Spec §6.5 rev 2 as P3's decision table (policy.ts `decide`), fed by one
 * statement: the artifact, its space, the caller's share and space role. In
 * a personal space this is today's rules exactly: deleted → null (unless the
 * owner and `allowDeleted`, for undelete); owner → owner; share for the
 * caller's email → share.role; team + owner/admin/member → viewer; public →
 * viewer; else null. Admins get no implicit access to private artifacts.
 */
export async function accessLevel(
  env: Env,
  c: Caller,
  artifactId: string,
  opts: { allowDeleted?: boolean } = {},
): Promise<Access | null> {
  // The policy gate (route-policy.ts) already loaded this row for this
  // request: reuse it once instead of a second D1 statement.
  const cache = prefetched.getStore();
  const key = accessKey(c, artifactId, opts);
  if (cache?.has(key)) {
    const hit = cache.get(key) ?? null;
    cache.delete(key);
    return hit;
  }
  return loadAccess(env, c, artifactId, opts);
}

type Access = { level: AccessLevel; artifact: ArtifactRow; personal: boolean };
const prefetched = new AsyncLocalStorage<Map<string, Access | null>>();
const accessKey = (c: Caller, id: string, opts: { allowDeleted?: boolean }) =>
  `${c.kind === "user" ? `u:${c.user.id}:${c.cap ?? ""}` : "anon"}|${id}|${opts.allowDeleted ? 1 : 0}`;

/**
 * Runs `fn` with a per-request access cache. Within it, `authorize(...,
 * { prefetch: true })` seeds the cache so the handler's own access check (same
 * caller, artifact and allowDeleted) costs no second D1 statement; each seeded
 * entry is used once.
 */
export function withAccessCache<T>(fn: () => Promise<T>): Promise<T> {
  return prefetched.run(new Map(), fn);
}

async function loadAccess(
  env: Env,
  c: Caller,
  artifactId: string,
  opts: { allowDeleted?: boolean },
): Promise<Access | null> {
  const db = getDb(env);
  const user = c.kind === "user" ? c.user : null;
  const email = user ? callerEmail(user) : null;
  const rows = await db
    .select({
      a: artifacts,
      shareRole: shares.role,
      kind: spaces.kind,
      publicLinks: spaces.publicLinks,
      allMembersRole: spaces.allMembersRole,
      // allMembersRole is decide()'s to add: it knows guests and the cap.
      spaceRank: user
        ? sql<number>`case when ${spaces.kind} = 'shared' then ${spaceRankSql(user.id)} else 0 end`
        : sql<number>`0`,
    })
    .from(artifacts)
    .leftJoin(spaces, eq(spaces.id, artifacts.spaceId))
    .leftJoin(
      shares,
      and(
        eq(shares.artifactId, artifacts.id),
        // No email → never matches a share.
        email ? eq(shares.email, email) : sql`0`,
      ),
    )
    .where(eq(artifacts.id, artifactId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const space: SpaceInput = {
    kind: row.kind,
    publicLinks: row.publicLinks,
    allMembersRole: row.allMembersRole,
    role: RANK_ROLE[row.spaceRank] ?? null,
  };
  const level = rowLevel(c, row.a, row.shareRole, space, opts);
  return level
    ? { level, artifact: row.a, personal: space.kind !== "shared" }
    : null;
}

/** An artifact's space as decide() reads it; a missing row reads as personal. */
export type SpaceInput = {
  kind: string | null;
  publicLinks: number | null;
  allMembersRole: string | null;
  /** The caller's max role from space_members and Every-space mappings. */
  role: SpaceRole | null;
};

const RANK_ROLE: Record<number, SpaceRole> = {
  1: "viewer",
  2: "editor",
  3: "manager",
};

/** The caller's level on an already-loaded row and its space. */
export function rowLevel(
  c: Caller,
  a: ArtifactRow,
  shareRole: string | null,
  space: SpaceInput,
  opts: { allowDeleted?: boolean } = {},
): AccessLevel | null {
  const user = c.kind === "user" ? c.user : null;
  return decide({
    caller: user ? { id: user.id, orgRole: user.role } : null,
    cap: capOfCaller(c),
    artifact: {
      spaceId: a.spaceId ?? "",
      spaceKind: space.kind === "shared" ? "shared" : "personal",
      visibility: visibilityOf(a.visibility),
      deleted: a.deletedAt != null,
    },
    space: {
      publicLinks: space.publicLinks === 1,
      allMembersRole: space.allMembersRole as SpaceRole | null,
    },
    spaceRole: space.role,
    shareRole:
      shareRole === "viewer" || shareRole === "editor" ? shareRole : null,
    allowDeleted: opts.allowDeleted === true,
  });
}

/** A space role's rank in SQL; anything unknown is 0 (fail closed, as decide). */
const rankSql = (role: SQL) =>
  sql`(case ${role} when 'viewer' then 1 when 'editor' then 2 when 'manager' then 3 else 0 end)`;

/**
 * The caller's Every-space rank: the max org mapping role over their groups,
 * resolved at read time. Uncorrelated, so SQLite evaluates it once per
 * statement; CROSS JOIN keeps org_group_mappings (a handful of rows) outer,
 * each probing directory_members by its primary key.
 */
const everyRankSql = (userId: string) =>
  sql`coalesce((select max(${rankSql(sql`ogm.role`)}) from ${orgGroupMappings} ogm
    cross join ${directoryMembers} dm on dm.group_id = ogm.group_id and dm.user_id = ${userId}), 0)`;

/**
 * The caller's role rank (0 to 3) in the artifact's space, without
 * allMembersRole: the max over their space_members rows (manual and sync) and
 * their Every-space rank. Callers apply it to shared spaces only.
 */
function spaceRankSql(
  userId: string,
  spaceId: SQL = sql`${artifacts.spaceId}`,
): SQL<number> {
  return sql<number>`max(
    coalesce((select max(${rankSql(sql`sm.role`)}) from ${spaceMembers} sm
      where sm.space_id = ${spaceId} and sm.user_id = ${userId}), 0),
    ${everyRankSql(userId)})`;
}

/**
 * The caller's full role rank in a shared space (0 to 3): spaceRankSql plus
 * `spaces.all_members_role` for uncapped members (decide's allMembers). The
 * space is `spaces` (joined), its id `spaceId`. Lists and checkListSpace
 * share it.
 */
export function roleRankSql(
  c: Caller,
  spaceId: SQL = sql`${artifacts.spaceId}`,
): SQL<number> {
  if (c.kind !== "user" || !c.user.id) return sql<number>`0`;
  return isTeamRole(c.user.role) && capOfCaller(c) == null
    ? sql<number>`max(${spaceRankSql(c.user.id, spaceId)}, ${rankSql(sql`${spaces.allMembersRole}`)})`
    : spaceRankSql(c.user.id, spaceId);
}

/**
 * The caller's level per row, as a CASE over `artifacts`, `spaces` (joined on
 * space_id) and `shares` (the caller's share, joined): decide() in SQL, so a
 * list or search reads its levels in the same statement. Null = no access.
 * `CASE x WHEN` evaluates the correlated role once per row.
 */
export function levelSql(
  c: Caller,
  opts: { allowDeleted?: boolean } = {},
): SQL<AccessLevel | null> {
  const user = c.kind === "user" && c.user.id ? c.user : null;
  const capped = capOfCaller(c) != null;
  const member = user !== null && isTeamRole(user.role);
  // The cap lowers every level to viewer (decide).
  const lv = (l: AccessLevel) => sql.raw(`'${capped ? "viewer" : l}'`);
  const shared = sql`${spaces.kind} = 'shared'`;
  const role = roleRankSql(c);
  const share = sql`(case ${shares.role} when 'editor' then 2 when 'viewer' then 1 else 0 end)`;
  // No space role: a share, then team (uncapped members), then a public link.
  const rest = sql`case ${share} when 2 then ${lv("editor")} when 1 then ${lv("viewer")} else case
    ${member && !capped ? sql`when ${artifacts.visibility} = 'team' then 'viewer'` : sql``}
    when ${artifacts.visibility} = 'public' then 'viewer'
    end end`;
  // Trash: the personal owner, or a shared space's manager; never capped.
  const trash =
    opts.allowDeleted && user && !capped
      ? sql`case when ${shared} then (case when ${role} = 3 then 'manager' end)
          when ${artifacts.spaceId} = ${user.id} then 'owner' end`
      : sql`null`;
  return sql<AccessLevel | null>`(case
    when ${artifacts.deletedAt} is not null then ${trash}
    when ${shared} then (case ${role} when 3 then ${lv("manager")} when 2 then ${lv("editor")}
      when 1 then (case when ${share} = 2 then ${lv("editor")} else ${lv("viewer")} end)
      else ${rest} end)
    ${user ? sql`when ${artifacts.spaceId} = ${user.id} then ${lv("owner")}` : sql``}
    else ${rest} end)`;
}

/**
 * A viewer's first-thumbnail right (can "thumbnail.write" with
 * firstThumbnail): through a share, or team access on a team artifact.
 */
export function firstThumbnailEligible(
  c: Caller,
  a: ArtifactRow,
  shared: boolean,
): boolean {
  if (c.kind !== "user") return false;
  return shared || (a.visibility === "team" && isTeamRole(c.user.role));
}

/** The caller's cap: the one source both decide() and can() read. */
export const capOfCaller = (c: Caller): CapReason | null =>
  c.kind === "user" ? (c.cap ?? null) : null;

const VISIBILITIES: ReadonlySet<string> = new Set(VisibilitySchema.options);
/** A stored visibility, or "private" when the row holds anything else (fail closed). */
const visibilityOf = (v: string): Visibility =>
  VISIBILITIES.has(v) ? (v as Visibility) : "private";

/** The context `can` needs for one caller and artifact. */
export function canCtx(c: Caller, a: ArtifactRow): CanCtx {
  return {
    cap: capOfCaller(c),
    personal: true,
    anonymous: c.kind !== "user",
    allowAnonymousWrites: a.allowAnonymousWrites === 1,
  };
}

/**
 * The artifact and the caller's level if they may take `action`; otherwise
 * 404 (never 403). The one check for owner-or-manager actions: never compare
 * levels for those, ask `can` (a manager fails requireAccess("owner")).
 */
export async function authorize(
  env: Env,
  c: Caller,
  artifactId: string,
  action: PolicyAction,
  opts: {
    allowDeleted?: boolean;
    prefetch?: boolean;
    /** The policy gate's floor for viewer thumbnails (never widens anything else). */
    ctx?: { firstThumbnail?: boolean };
  } = {},
): Promise<{ level: AccessLevel; artifact: ArtifactRow }> {
  let r: Access | null;
  if (opts.prefetch) {
    r = await loadAccess(env, c, artifactId, opts);
    prefetched.getStore()?.set(accessKey(c, artifactId, opts), r);
  } else r = await accessLevel(env, c, artifactId, opts);
  if (
    !r ||
    !can(r.level, action, {
      ...canCtx(c, r.artifact),
      personal: r.personal,
      ...opts.ctx,
    })
  )
    throw new ApiError("not_found", "Not found");
  return r;
}

/**
 * Does `level` satisfy `min`? "owner" is exact: a space "manager" (hosted M1,
 * same rank) never passes an owner check, so single transfer and anything
 * else owner-only stays with the personal owner.
 */
export const meetsLevel = (level: AccessLevel, min: AccessLevel): boolean =>
  min === "owner" ? level === "owner" : RANK[level] >= RANK[min];

/** The artifact if the caller has at least `min`; otherwise 404 (never 403). */
export async function requireAccess(
  env: Env,
  c: Caller,
  artifactId: string,
  min: AccessLevel,
  opts: { allowDeleted?: boolean } = {},
): Promise<ArtifactRow> {
  const r = await accessLevel(env, c, artifactId, opts);
  if (!r || !meetsLevel(r.level, min))
    throw new ApiError("not_found", "Not found");
  return r.artifact;
}

/**
 * WHERE fragment over `artifacts` for list/search, consistent with authorize
 * (levelSql gives each row's level):
 * - mine: in the caller's personal space (and theirs by owner_id).
 * - shared: a share for the caller's email, outside their personal space.
 * - team: visibility team or public, for uncapped owner/admin/members (a
 *   space's public-links toggle only refuses new public links).
 * - spaces: shared spaces where the caller has a role: their space_members
 *   rows, allMembersRole (never guests or capped callers), and the
 *   Every-space mappings, resolved at read time (never personal spaces).
 * - all and space: the union (`space` is narrowed by `spaceId`).
 * `spaceId` narrows any scope to one space. Public artifacts reachable only
 * by link are not listed to guests or capped callers (spec: guests see only
 * what's shared). Anonymous → always false (list routes require a user).
 * Deleted rows are excluded, unless `includeDeleted`, and then only the
 * caller's own personal ones.
 */
export function listFilterSql(
  c: Caller,
  scope: ListQuery["scope"],
  includeDeleted = false,
  spaceId?: string,
): SQL {
  if (c.kind !== "user") return sql`0`;
  const { user } = c;
  const capped = capOfCaller(c) != null;
  const email = callerEmail(user);
  // owner_id too: a personal space's artifacts are its owner's (create,
  // transfer and member removal move both). The unary + keeps SQLite off
  // artifacts_space_live_idx, so mine walks the ordered
  // owner_updated_live_idx and a page stops at its limit with no sort.
  const mine = and(
    eq(artifacts.ownerId, user.id),
    sql`+${artifacts.spaceId} = ${user.id}`,
  ) as SQL;
  const sharedWithMe = email
    ? and(ne(artifacts.spaceId, user.id), sharedIds(email))
    : undefined;
  // Capped callers see team artifacts only through a share or a space role
  // (decide()).
  const team =
    TEAM_ROLES.includes(user.role) && !capped
      ? inArray(artifacts.visibility, ["team", "public"])
      : undefined;
  // Two branches, so each plans on artifacts_space_live_idx.
  const inSpaces = [
    sql`${artifacts.spaceId} in (select sm.space_id from ${spaceMembers} sm
      join ${spaces} sp on sp.id = sm.space_id and sp.kind = 'shared'
      where sm.user_id = ${user.id})`,
    // Every shared space, when the caller has an Every-space mapping or the
    // space has an allMembersRole: one walk over spaces.
    sql`${artifacts.spaceId} in (select sp.id from ${spaces} sp where sp.kind = 'shared'
      and (${TEAM_ROLES.includes(user.role) && !capped ? sql`sp.all_members_role is not null or ` : sql``}${everyRankSql(user.id)} > 0))`,
  ];
  const parts =
    scope === "mine"
      ? [mine]
      : scope === "shared"
        ? [sharedWithMe]
        : scope === "team"
          ? [team]
          : scope === "spaces"
            ? inSpaces
            : [mine, sharedWithMe, team, ...inSpaces];
  const present = parts.filter((p): p is SQL => p !== undefined);
  if (!present.length) return sql`0`;
  // `deleted_at is null` inside every branch: only then does SQLite plan each
  // branch on its partial index (MULTI-INDEX OR) rather than walking all live
  // rows; there are no non-partial owner/visibility indexes (#248).
  const branches = present.map((p) => and(isNull(artifacts.deletedAt), p));
  // Trash is for callers who can undelete: never capped ones. Personal only:
  // owner_id puts it on the trash index (a personal space's artifacts are
  // its owner's); a shared space's trash waits for its own index.
  if (includeDeleted && !capped)
    branches.push(
      and(
        isNotNull(artifacts.deletedAt),
        mine,
        ...(present.includes(mine) ? [] : [or(...present)]),
      ),
    );
  const filter = or(...branches) ?? sql`0`;
  return spaceId === undefined
    ? filter
    : (and(eq(artifacts.spaceId, spaceId), filter) as SQL);
}

/**
 * A list or search narrowed to `spaceId`, in one statement: 400
 * space_personal for another user's personal space (the caller's own is
 * their `mine`); 404 for an unknown space and for a shared one where the
 * caller has no role (a space_members row, an Every-space mapping, or
 * allMembersRole when uncapped), so a space's existence never leaks.
 */
export async function checkListSpace(
  env: Env,
  c: Caller,
  spaceId: string,
): Promise<void> {
  const [row] = await getDb(env)
    .select({ kind: spaces.kind, rank: roleRankSql(c, sql`${spaces.id}`) })
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), isNull(spaces.deletedAt)))
    .limit(1);
  if (!row) throw new ApiError("not_found", "Not found");
  if (row.kind !== "shared") {
    if (c.kind !== "user" || c.user.id !== spaceId)
      throw new ApiError("space_personal", "Pick a shared space");
    return;
  }
  if (!(row.rank > 0)) throw new ApiError("not_found", "Not found");
}

/**
 * `artifacts.id IN (SELECT artifact_id FROM shares WHERE email = ?)`: evaluated
 * once (uncorrelated) via shares_email_idx, not probed per artifact row.
 */
function sharedIds(email: string): SQL {
  return sql`${artifacts.id} in (select ${shares.artifactId} from ${shares} where ${shares.email} = ${email})`;
}
