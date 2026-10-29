import { normalizeEmail } from "@oa/auth-core";
import { type Member, newId, type Role, type UserRef } from "@oa/shared";
import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { withCap, withPlan } from "../auth/authz.js";
import { authConfig } from "../auth/config.js";
import { capOf, planCapsRole } from "../auth/policy.js";
import { seedPlan } from "../billing/features.js";
import { billingOn, CHECK_KEY, PLAN_KEY, planOfRaw } from "../billing/plan.js";
import { getDb } from "../db/client.js";
import { shares, users } from "../db/schema.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { signInAuditByEmail } from "./audit.js";

type UserRow = typeof users.$inferSelect;
type NameFields = Pick<UserRow, "email" | "name" | "displayName">;

const localPart = (email: string) => email.slice(0, email.lastIndexOf("@"));

/** The IdP name when it is a real name: not blank, not the email's local part (any case). */
export function idpName(name: string | null, email: string): string | null {
  const n = (name ?? "").trim();
  return n && n.toLowerCase() !== localPart(email).toLowerCase() ? n : null;
}

/** The name to render: display name, else a real IdP name, else the full email. Never the bare local part. */
export function effectiveName(u: NameFields): string {
  return u.displayName || idpName(u.name, u.email) || u.email;
}

/**
 * A UserRef for `caller`: anonymous callers get no email, and so no email
 * fallback for the name either (null when the user has no real name).
 */
export function toUserRef(
  u: NameFields & { id: string },
  signedIn: boolean,
): UserRef {
  return signedIn
    ? { id: u.id, email: u.email, name: effectiveName(u) }
    : {
        id: u.id,
        email: null,
        name: u.displayName || idpName(u.name, u.email),
      };
}

export function toMember(
  r: Pick<
    UserRow,
    "id" | "email" | "name" | "displayName" | "role" | "lastSeenAt"
  >,
): Member {
  const email = normalizeEmail(r.email) ?? r.email;
  return {
    id: r.id,
    email,
    name: effectiveName({ ...r, email }),
    role: r.role as Role,
    lastSeenAt:
      r.lastSeenAt == null ? null : new Date(r.lastSeenAt).toISOString(),
  };
}

const defaultName = (email: string) => email.split("@")[0] || email;

/**
 * The only way the app inserts a user (P2 seam with P3): every path that
 * creates a person (sign-in, invite, codes, dev and test hooks) goes through
 * here or through googleLinkStmts below. P3's AFTER INSERT trigger adds the
 * personal space. Returns the drizzle insert for the caller's conflict rule.
 */
export function insertUser(
  env: Env,
  u: {
    email: string;
    name: string;
    role: Role;
    createdAt: number;
    lastSeenAt?: number;
  },
) {
  return getDb(env)
    .insert(users)
    .values({ id: newId(), ...u });
}

/**
 * First Google sign-in, race-safe in one batch: create the user (or touch an
 * active one), link (google, sub) only to an ACTIVE row with that email (never
 * a removed or suspended one), then read back the row and its Google link.
 * The caller decides from the read: status not active → removed; another
 * subject → identity_conflict.
 */
export function googleLinkStmts(
  env: Env,
  p: {
    email: string;
    name: string | null;
    role: Role;
    subject: string;
    tenant: string;
    now: number;
  },
): D1PreparedStatement[] {
  return [
    stmt(
      env.DB,
      // One owner: an 'owner' insert while an owner row exists becomes a member.
      `insert into users (id, email, name, role, created_at, last_seen_at) values (?1, ?2, ?3,
         case when ?4 = 'owner' and exists (select 1 from users where role = 'owner') then 'member' else ?4 end, ?5, ?5)
       on conflict(email) do update set last_seen_at = excluded.last_seen_at where users.status = 'active'`,
    ).bind(newId(), p.email, p.name ?? defaultName(p.email), p.role, p.now),
    stmt(
      env.DB,
      `insert into identities (provider, subject, tenant, user_id, created_at)
       select 'google', ?1, ?2, id, ?3 from users where email = ?4 and status = 'active'
       on conflict do nothing`,
    ).bind(p.subject, p.tenant, p.now, p.email),
    stmt(
      env.DB,
      `select u.id, u.email, u.name, u.display_name as displayName, u.role, u.last_seen_at as lastSeenAt,
              u.status, i.subject
       from users u left join identities i on i.user_id = u.id and i.provider = 'google'
       where u.email = ?1`,
    ).bind(p.email),
    // A sign-in that linked after an admin's reset consumes google_relink
    // (directory sync then finds the row by its identity).
    stmt(
      env.DB,
      `update users set google_relink = 0 where email = ?1 and google_relink = 1
       and exists (select 1 from identities i where i.provider = 'google' and i.user_id = users.id)`,
    ).bind(p.email),
  ];
}

/** Insert, or on email conflict force `role` (if given) and refresh name/last_seen_at. */
/**
 * The write plus, when given, the auth.signin audit statement in one D1
 * batch: both commit or neither does.
 */
type AuditItem = ReturnType<typeof signInAuditByEmail>;

async function withAudit<T>(
  env: Env,
  q: BatchItem<"sqlite"> & PromiseLike<T>,
  auditQ: AuditItem | null,
): Promise<T> {
  if (!auditQ) return await q;
  const [out] = await getDb(env).batch([q, auditQ]);
  return out as T;
}

async function upsert(
  env: Env,
  email: string,
  name: string | null,
  role: Role,
  forceRole: boolean,
  auditQ: AuditItem | null = null,
): Promise<UserRow> {
  const now = Date.now();
  const set: Partial<UserRow> = { lastSeenAt: now };
  if (name !== null) set.name = name;
  if (forceRole) set.role = role;
  const [row] = await withAudit(
    env,
    insertUser(env, {
      email,
      name: name ?? defaultName(email),
      role,
      createdAt: now,
      lastSeenAt: now,
    })
      .onConflictDoUpdate({ target: users.email, set })
      .returning(),
    auditQ,
  );
  if (!row) throw new Error("user upsert returned no row");
  return row;
}

export async function upsertOnLogin(
  env: Env,
  email: string,
  name: string | null,
  /** Audit the sign-in (auth.signin) in the same batch as each admitting write. */
  signIn?: { provider: string },
): Promise<Member | null> {
  // Non-ASCII / malformed emails are no-access: never folded onto an account.
  const e = normalizeEmail(email);
  if (!e) return null;
  // Only the admitting writes below carry it: a refusal writes nothing.
  const auditQ = signIn ? signInAuditByEmail(env, e, signIn.provider) : null;
  const owner = normalizeEmail(env.OWNER_EMAIL ?? "");
  if (owner && e === owner)
    return toMember(await upsert(env, e, name, "owner", true, auditQ));

  const db = getDb(env);
  const existing = (
    await db.select().from(users).where(eq(users.email, e)).limit(1)
  )[0];
  if (existing) {
    // Deactivated (a guest whose last share went, or P3's sync): no sign-in.
    // A new share reactivates a guest (putShare).
    if (existing.status !== "active") return null;
    const set: Partial<UserRow> = { lastSeenAt: Date.now() };
    if (name !== null) set.name = name;
    const [row] = await withAudit(
      env,
      db.update(users).set(set).where(eq(users.id, existing.id)).returning(),
      auditQ,
    );
    return row ? toMember(row) : null;
  }

  const shared = await db
    .select({ a: shares.artifactId })
    .from(shares)
    .where(eq(shares.email, e))
    .limit(1);
  if (shared.length === 0) return null;
  // Concurrent first logins race on the unique email: the loser just refreshes.
  return toMember(await upsert(env, e, name, "guest", false, auditQ));
}

/** Dev-only: create or update the user with exactly this role. */
export async function upsertWithRole(
  env: Env,
  email: string,
  role: Role,
): Promise<Member> {
  const e = normalizeEmail(email);
  if (!e) throw new Error("invalid email");
  return toMember(await upsert(env, e, null, role, true));
}

const USER_COLS =
  "id, email, name, display_name as displayName, role, last_seen_at as lastSeenAt, session_epoch as sessionEpoch, restricted_manual as restrictedManual, restricted_sync as restrictedSync, status_changed_at as statusChangedAt";

/**
 * A synced user (P3 T18): a Google identity bound to the connected directory.
 * directory_state is cleared on disconnect, so "while a directory is
 * connected" needs no binding read.
 */
const SYNCED =
  "exists (select 1 from identities i where i.user_id = users.id and i.provider = 'google' and i.directory_bound = 1)";
/**
 * The sync state, read once per statement: one directory_state PK probe
 * (no row, '' : no directory). Both checks below branch on it, so the
 * identity is read only during a mismatch or an outage. Pinned in d1-rows.
 */
const STATE = `(select coalesce((select ds.value from directory_state ds where ds.key = 'sync.state'), '') as st) d`;
/** customer_mismatch fails closed for synced users. */
const MISMATCH = `(d.st = 'customer_mismatch' and ${SYNCED})`;
/**
 * Cookie sessions only (?2 = 1) while sync is not ok: when it went
 * unhealthy, for a synced user (the 24 h browser session cap), from the
 * health row. PATs, OAuth grants and healthy installs never read it.
 */
const CAP_SINCE = `case when ?2 = 1 and d.st not in ('', 'ok') and ${SYNCED}
  then (select json_extract(h.value, '$.unhealthySince') from directory_state h where h.key = 'sync.health')
  end as capSince`;

/**
 * Hosted billing (HOSTED=1 only, so self-hosted statements are unchanged):
 * the cached plan and its read attempts, two settings PK probes in the same
 * statement. withEpoch derives the plan cap from them (billing/plan.ts).
 */
const PLAN_COLS = `, (select value from settings where key = '${PLAN_KEY}') as billingPlan,
  (select value from settings where key = '${CHECK_KEY}') as billingCheck`;

const userById = (
  plan: string,
) => `select ${USER_COLS}, ${CAP_SINCE}${plan} from ${STATE}, users
  where id = ?1 and status = 'active' and not ${MISMATCH} limit 1`;
const USER_BY_ID = userById("");
const USER_BY_ID_HOSTED = userById(PLAN_COLS);
/** The org owner denied by customer_mismatch, for break-glass only (T18). */
const mismatchOwner = (
  plan: string,
) => `select ${USER_COLS}, null as capSince${plan} from ${STATE}, users
  where id = ?1 and status = 'active' and role = 'owner' and ${MISMATCH} limit 1`;
const MISMATCH_OWNER = mismatchOwner("");
const MISMATCH_OWNER_HOSTED = mismatchOwner(PLAN_COLS);

type UserByIdRow = Pick<
  UserRow,
  | "id"
  | "email"
  | "name"
  | "displayName"
  | "role"
  | "lastSeenAt"
  | "sessionEpoch"
  | "restrictedManual"
  | "restrictedSync"
  | "statusChangedAt"
> & {
  capSince: number | null;
  /** Hosted statements only: the settings rows (billing/plan.ts). */
  billingPlan?: string | null;
  billingCheck?: string | null;
};

export type UserWithEpoch = {
  user: Member;
  sessionEpoch: number;
  /** When status last changed (ms) or null: OAuth grants issued at or before it are refused. */
  statusChangedAt: number | null;
  /**
   * Cookie reads only: when directory sync went unhealthy (ms), for a synced
   * user; null otherwise (the 24 h browser session cap, T18).
   */
  capSince: number | null;
};

function withEpoch(env: Env, row: UserByIdRow | null): UserWithEpoch | null {
  // Every request's user comes through here (session, PAT, OAuth), so the cap
  // is set once (P3's capOf: the one source authz's CAP reads). Sources: P2's
  // authConfig.guestsReadOnly and P3's restriction columns (0009).
  if (!row) return null;
  const plan = planOfRaw(env, row.billingPlan, row.billingCheck, Date.now());
  // The same statement read the plan: this invocation keeps it (no second
  // read for its features checks).
  seedPlan(plan);
  // P2/P3's cap first; then, hosted, the plan cap: a free or read-only
  // instance is read-only for everyone but the org owner (writes only).
  const cap =
    capOf(
      {
        role: row.role as Role,
        // Fail closed: any non-zero flag restricts.
        restrictedManual: row.restrictedManual !== 0,
        restrictedSync: row.restrictedSync !== 0,
      },
      authConfig(env),
    ) ?? (plan?.lock && planCapsRole(row.role as Role) ? "plan" : null);
  return {
    user: withPlan(withCap(toMember(row), cap), plan),
    sessionEpoch: row.sessionEpoch,
    statusChangedAt: row.statusChangedAt ?? null,
    capSince: typeof row.capSince === "number" ? row.capSince : null,
  };
}

/**
 * Every authenticated request: one prepared D1 statement, no ORM mapping.
 * A deactivated user (status not 'active') resolves to null, so their session
 * cookie, PATs and OAuth tokens all stop working; so does a synced user while
 * the directory is in customer_mismatch (P3 T18). `sessionEpoch` is what a
 * session cookie's `e` must equal. `cookie` adds capSince.
 */
export async function getUserWithEpoch(
  env: Env,
  id: string,
  o: { cookie?: boolean } = {},
): Promise<UserWithEpoch | null> {
  return withEpoch(
    env,
    await stmt(env.DB, billingOn(env) ? USER_BY_ID_HOSTED : USER_BY_ID)
      .bind(id, o.cookie ? 1 : 0)
      .first<UserByIdRow>(),
  );
}

/**
 * The org owner that getUserWithEpoch refused for customer_mismatch, else
 * null. Only the break-glass routes and the Google sign-in read it (T18).
 */
export async function getMismatchOwner(
  env: Env,
  id: string,
): Promise<UserWithEpoch | null> {
  return withEpoch(
    env,
    await stmt(env.DB, billingOn(env) ? MISMATCH_OWNER_HOSTED : MISMATCH_OWNER)
      .bind(id)
      .first<UserByIdRow>(),
  );
}

export async function getUser(env: Env, id: string): Promise<Member | null> {
  return (await getUserWithEpoch(env, id))?.user ?? null;
}

export type Profile = {
  displayName: string | null;
  suggestedName: string | null;
  needsDisplayName: boolean;
};

function toProfile(r: NameFields): Profile {
  const suggestedName = idpName(r.name, r.email);
  return {
    displayName: r.displayName,
    suggestedName,
    needsDisplayName: !r.displayName && !suggestedName,
  };
}

/** Me's name fields. */
export async function getProfile(env: Env, id: string): Promise<Profile> {
  const row = (
    await getDb(env)
      .select({
        email: users.email,
        name: users.name,
        displayName: users.displayName,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1)
  )[0];
  if (!row) throw new Error("user not found");
  return toProfile(row);
}

/** Sets the user's chosen name (validated by MePatchSchema); sign-in never changes it. */
export async function setDisplayName(
  env: Env,
  id: string,
  displayName: string,
): Promise<{ member: Member; profile: Profile }> {
  const [row] = await getDb(env)
    .update(users)
    .set({ displayName })
    .where(eq(users.id, id))
    .returning();
  if (!row) throw new Error("user not found");
  return { member: toMember(row), profile: toProfile(row) };
}
