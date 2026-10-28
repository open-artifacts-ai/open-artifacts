// P4 (review item 9): the trash listing, R.trash. Deleted artifacts the
// caller may restore (POST R.restoreDeleted): their personal trash and, with
// spaces on, the trash of every shared space where their space role is
// manager (uncapped; decide()'s trash rule). Org admins have no implicit
// access: one who self-added as manager counts through that role. Newest
// deletedAt first.
import {
  type AccessLevel,
  LIMITS,
  type Page,
  type TrashItem,
  type TrashQuery,
} from "@oa/shared";
import {
  and,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { type Caller, capOfCaller, roleRankSql } from "../auth/authz.js";
import { getDb } from "../db/client.js";
import { artifacts, spaces, users } from "../db/schema.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { decodeCursor, encodeCursor, redact, toSummary } from "./artifacts.js";
import { spacesOn } from "./spaces.js";

const DAY = 86_400_000;
/** How long a deleted artifact stays restorable (the purge cron's window). */
export const TRASH_MS = LIMITS.softDeleteDays * DAY;
/** The personal space's name in a trash row (never the stored one). */
export const PERSONAL_NAME = "Personal";

const notFound = () => new ApiError("not_found", "Not found");
const iso = (t: number) => new Date(t).toISOString();

/**
 * The shared spaces whose trash the caller lists, as a subquery of ids: live
 * ones where their full role rank (roleRankSql, allMembersRole included) is
 * manager.
 */
function managedSpaceIds(c: Caller & { kind: "user" }): SQL {
  return sql`(select ${spaces.id} from ${spaces} where ${spaces.kind} = 'shared'
    and ${spaces.deletedAt} is null and ${roleRankSql(c, sql`${spaces.id}`)} = 3)`;
}

/** GET R.trash. Signed-in callers only (anonymous 401). */
export async function listTrash(
  env: Env,
  c: Caller,
  q: TrashQuery,
): Promise<Page<TrashItem>> {
  if (c.kind !== "user") throw new ApiError("unauthorized", "Sign in required");
  const { user } = c;
  const capped = capOfCaller(c) != null;
  const on = spacesOn(env);
  const db = getDb(env);

  // Which trash: personal (the caller's own space id), one shared space, or
  // everything they may restore.
  let personal = true;
  let shared: SQL | null = on && !capped ? managedSpaceIds(c) : null;
  if (q.spaceId !== undefined && q.spaceId !== user.id) {
    if (!on)
      throw new ApiError("bad_request", "Spaces are off: only your own trash", {
        path: "spaceId",
        reason: "invalid",
      });
    const [sp] = await db
      .select({
        kind: spaces.kind,
        managed: sql<number>`${roleRankSql(c, sql`${spaces.id}`)} = 3`,
      })
      .from(spaces)
      .where(and(eq(spaces.id, q.spaceId), isNull(spaces.deletedAt)))
      .limit(1);
    // Unknown, someone else's personal space, or a shared one the caller
    // doesn't manage (or can't see): 404 alike, no existence oracle.
    if (!sp || sp.kind !== "shared" || capped || !sp.managed) throw notFound();
    personal = false;
    shared = sql`(${q.spaceId})`;
  } else if (q.spaceId !== undefined) shared = null;
  // Trash is for those who can restore: never capped callers.
  if (capped) return { items: [], nextCursor: null };

  const branches: SQL[] = [];
  // owner_id too: the (owner_id, deleted_at) trash index serves it.
  if (personal)
    branches.push(
      and(
        eq(artifacts.ownerId, user.id),
        sql`+${artifacts.spaceId} = ${user.id}`,
      ) as SQL,
    );
  if (shared) branches.push(sql`${artifacts.spaceId} in ${shared}`);
  const conds: (SQL | undefined)[] = [
    isNotNull(artifacts.deletedAt),
    // Past the window it can't be restored; the purge cron removes it.
    gte(artifacts.deletedAt, Date.now() - TRASH_MS),
    or(...branches),
  ];
  if (q.cursor !== undefined) {
    const k = decodeCursor(q.cursor);
    conds.push(
      sql`(${artifacts.deletedAt} < ${k.u} or (${artifacts.deletedAt} = ${k.u} and ${artifacts.id} < ${k.i}))`,
    );
  }
  const rows = await db
    .select({
      a: artifacts,
      ownerEmail: users.email,
      ownerName: users.name,
      ownerDisplayName: users.displayName,
      kind: spaces.kind,
      spaceName: spaces.name,
    })
    .from(artifacts)
    .innerJoin(users, eq(users.id, artifacts.ownerId))
    .leftJoin(spaces, eq(spaces.id, artifacts.spaceId))
    .where(and(...conds))
    .orderBy(desc(artifacts.deletedAt), desc(artifacts.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const items = page.map((r): TrashItem => {
    const own = r.kind !== "shared";
    const level: AccessLevel = own ? "owner" : "manager";
    const deletedAt = r.a.deletedAt as number;
    const s = toSummary(
      env,
      r.a,
      redact(
        {
          id: r.a.ownerId,
          email: r.ownerEmail,
          name: r.ownerName,
          displayName: r.ownerDisplayName,
        },
        c,
      ),
      level,
    );
    return {
      ...s,
      deletedAt: iso(deletedAt),
      purgeAt: iso(deletedAt + TRASH_MS),
      space: {
        id: r.a.spaceId ?? user.id,
        name: own ? PERSONAL_NAME : (r.spaceName ?? ""),
        personal: own,
      },
    };
  });
  const last = page[page.length - 1];
  return {
    items,
    nextCursor:
      rows.length > q.limit && last
        ? encodeCursor({ u: last.a.deletedAt as number, i: last.a.id })
        : null,
  };
}
