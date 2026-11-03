// Parity 2: one-time notices of guest shares the guest cap now reads as
// viewer (Me.notices), on Access-only installs only: direct sign-in and
// hosted installs always capped guests, so no share changed there.
// - guestShares: each member, for artifacts they own and can still read the
//   share list of; dismissed per user.
// - guestSummary: the org owner, counts only plus guests who own artifacts;
//   dismissed install-wide.
// Each is computed live and stays hidden for good once dismissed.

import { normalizeEmail } from "@oa/auth-core";
import {
  type CapReason,
  GUEST_OWNERS_NOTICE_LIMIT,
  GUEST_SHARES_NOTICE_LIMIT,
  type GuestSharesNotice,
  type GuestSummaryNotice,
  type Member,
  type MeNotices,
  type NoticeId,
} from "@oa/shared";
import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { readsSharesSql } from "../auth/authz.js";
import { authConfig } from "../auth/config.js";
import { orgCan } from "../auth/policy.js";
import { signInMode } from "../auth/sign-in.js";
import { getDb } from "../db/client.js";
import { artifacts, settings, shares, spaces, users } from "../db/schema.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { statusOf } from "./members.js";

/** The settings row that marks guest_summary dismissed for this install. */
export const summaryKey = "notice_dismissed:guest_summary";

/**
 * The settings row that marks guest_shares dismissed for one user. The
 * prefix is kept out of getSettingsKv (one row per member who dismissed).
 */
export const USER_NOTICE_PREFIX = "notice_user:";
export const userNoticeKey = (userId: string, id: NoticeId): string =>
  `${USER_NOTICE_PREFIX}${userId}:${id}`;

const DISMISS = `insert into settings (key, value) values (?1, ?2)
  on conflict (key) do nothing`;

/**
 * Marks `id` dismissed: guest_shares for `userId` only, guest_summary for the
 * install (idempotent; the first time is kept). The route checks who may.
 */
export async function dismissNotice(
  env: Env,
  userId: string,
  id: NoticeId,
): Promise<void> {
  const key = id === "guest_shares" ? userNoticeKey(userId, id) : summaryKey;
  await stmt(env.DB, DISMISS).bind(key, String(Date.now())).run();
}

/**
 * A share the cap now reads as viewer: above viewer, on a live artifact, to
 * an active guest or to an address with no users row yet (it becomes a guest
 * at its first Access sign-in, upsertOnLogin). myGuestShares repeats these
 * conditions as a drizzle query: change both.
 */
const GUEST_SHARE = `from shares s
  join artifacts a on a.id = s.artifact_id
  left join users u on u.email = s.email
  where s.role <> 'viewer' and a.deleted_at is null
    and (u.id is null or (u.role = 'guest' and u.status = 'active'))`;

/**
 * The caller's own artifacts, where they can still read the share list: a
 * row names a guest, so it follows GET R.shares, not owner_id alone (someone
 * removed from or demoted in a shared space keeps owner_id). readsSharesSql
 * is decide() in the same statement. Newest share first; one past the limit
 * says more.
 */
// The conditions must stay GUEST_SHARE's, or the summary and this list differ.
function myGuestShares(env: Env, user: Member, limit: number) {
  const guest = alias(shares, "guest_share");
  const email = normalizeEmail(user.email);
  return getDb(env)
    .select({
      artifactId: guest.artifactId,
      title: artifacts.title,
      guestEmail: guest.email,
    })
    .from(guest)
    .innerJoin(artifacts, eq(artifacts.id, guest.artifactId))
    .innerJoin(spaces, eq(spaces.id, artifacts.spaceId))
    .leftJoin(
      shares,
      and(
        eq(shares.artifactId, artifacts.id),
        email ? eq(shares.email, email) : sql`0`,
      ),
    )
    .leftJoin(users, eq(users.email, guest.email))
    .where(
      and(
        eq(artifacts.ownerId, user.id),
        isNull(artifacts.deletedAt),
        ne(guest.role, "viewer"),
        or(
          isNull(users.id),
          and(eq(users.role, "guest"), eq(users.status, "active")),
        ),
        readsSharesSql(user),
      ),
    )
    .orderBy(desc(guest.createdAt), guest.artifactId, guest.email)
    .limit(limit);
}

const SUMMARY_COUNTS = `select count(*) as shares, count(distinct a.owner_id) as owners
  ${GUEST_SHARE}`;

/** Guests (any status) with live artifacts in their personal space. */
const GUEST_OWNERS = `select u.id as userId, u.email as email, u.status as status, count(*) as artifacts
  from users u join artifacts a on a.space_id = u.id and a.owner_id = u.id
  where u.role = 'guest' and a.deleted_at is null
  group by u.id
  order by artifacts desc, u.email
  limit ?1`;

type ShareRow = { artifactId: string; title: string; guestEmail: string };
type OwnerRow = {
  userId: string;
  email: string;
  artifacts: number;
  status: string;
};

/**
 * Me.notices for `user`, or null when none is present. `kv` is the settings
 * rows /me already read (the install-wide summary dismissal). Only on
 * Access-only installs: never hosted (HOSTED=1) or direct sign-in, where
 * guests were always capped.
 */
export async function meNotices(
  env: Env,
  user: Member,
  cap: CapReason | null,
  kv: Map<string, string>,
): Promise<MeNotices | null> {
  if (env.HOSTED === "1" || signInMode(authConfig(env)) === "direct")
    return null;
  const own = orgCan(user, "notices.own", { cap });
  const summary =
    orgCan(user, "notices.manage", { cap }) && !kv.has(summaryKey);
  if (!own && !summary) return null;
  const out: MeNotices = {};
  if (own) {
    const db = getDb(env);
    const [d, rows] = await db.batch([
      db
        .select({ key: settings.key })
        .from(settings)
        .where(eq(settings.key, userNoticeKey(user.id, "guest_shares"))),
      myGuestShares(env, user, GUEST_SHARES_NOTICE_LIMIT + 1),
    ]);
    if (!d.length && rows.length > 0) out.guestShares = toShares(rows);
  }
  if (summary) {
    const n = await guestSummary(env);
    if (n) out.guestSummary = n;
  }
  return out.guestShares || out.guestSummary ? out : null;
}

function toShares(rows: ShareRow[]): GuestSharesNotice {
  return {
    items: rows.slice(0, GUEST_SHARES_NOTICE_LIMIT).map((r) => ({
      artifactId: r.artifactId,
      title: r.title,
      guestEmail: r.guestEmail,
      // shares_role_check allows only viewer and editor, so above viewer is editor.
      role: "editor" as const,
    })),
    more: rows.length > GUEST_SHARES_NOTICE_LIMIT,
  };
}

/** The org owner's summary, or null when no guest share and no guest owner. */
async function guestSummary(env: Env): Promise<GuestSummaryNotice | null> {
  const [c, o] = await env.DB.batch([
    stmt(env.DB, SUMMARY_COUNTS),
    stmt(env.DB, GUEST_OWNERS).bind(GUEST_OWNERS_NOTICE_LIMIT + 1),
  ]);
  const counts = c?.results[0] as { shares: number; owners: number };
  const owners = (o?.results ?? []) as OwnerRow[];
  if (counts.shares === 0 && owners.length === 0) return null;
  return {
    shares: counts.shares,
    owners: counts.owners,
    guestOwners: owners.slice(0, GUEST_OWNERS_NOTICE_LIMIT).map((r) => ({
      userId: r.userId,
      email: r.email,
      artifacts: r.artifacts,
      status: statusOf(r.status),
    })),
    more: owners.length > GUEST_OWNERS_NOTICE_LIMIT,
  };
}
