import { normalizeEmail } from "@oa/auth-core";
import type {
  AuditReason,
  Member,
  MemberInvite,
  MemberInviteResult,
  MemberPatch,
  MemberStatus,
  Settings,
  SettingsPatch,
} from "@oa/shared";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { managesAdmins } from "../auth/authz.js";
import { authConfig } from "../auth/config.js";
import { isOrgAdmin } from "../auth/policy.js";
import { getDb } from "../db/client.js";
import {
  agentGrants,
  artifacts,
  identities,
  reservedArtifacts,
  shares,
  spaces,
  tokens,
  uploads,
  users,
  versions,
} from "../db/schema.js";
import { stmt } from "../db/stmt.js";
import { emailEnabled, sendEmail } from "../email/send.js";
import { inviteEmail, senderName } from "../email/templates.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { revokeAllGrants } from "../mcp/oauth-api.js";
import {
  closeRuntimeSockets,
  MAX_CLOSE,
  revokeUserLive,
} from "../runtime/revoke.js";
import { type AuditActor, audit, userActor } from "./audit.js";
import { RESTRICTED_SYNC_FOR_USER } from "./restriction.js";
import { insertUser, toMember } from "./users.js";

/** Active members only (the contract's default `status`). */
export async function listMembers(env: Env): Promise<Member[]> {
  const rows = await getDb(env)
    .select()
    .from(users)
    .where(eq(users.status, "active"))
    .orderBy(asc(users.createdAt), asc(users.id));
  return rows.map(toMember);
}

/**
 * Pre-creates the user row, then emails the invitee (best effort).
 * 400 on an invalid (non-ASCII) email, 409 if it exists.
 */
export async function inviteMember(
  env: Env,
  inviter: Member,
  input: MemberInvite,
): Promise<MemberInviteResult> {
  const email = normalizeEmail(input.email);
  if (!email) throw new ApiError("bad_request", "Invalid email");
  const [row] = await insertUser(env, {
    email,
    name: "",
    role: input.role,
    createdAt: Date.now(),
  })
    .onConflictDoNothing({ target: users.email })
    .returning();
  if (!row) throw new ApiError("conflict", "Already a member");
  let emailed = false;
  if (emailEnabled(env)) {
    const instance = (await getSettings(env).catch(() => DEFAULT_SETTINGS))
      .name;
    emailed = await sendEmail(
      env,
      inviter.id,
      email,
      () =>
        inviteEmail({
          inviter: senderName(inviter),
          instance,
          recipient: email,
          appHost: env.APP_HOST,
        }),
      {
        kind: "invite",
        replyTo: normalizeEmail(inviter.email) ?? undefined,
        instance,
      },
    );
  }
  return { ...toMember(row), emailed };
}

async function getRow(env: Env, id: string) {
  const row = (
    await getDb(env).select().from(users).where(eq(users.id, id)).limit(1)
  )[0];
  if (!row) throw new ApiError("not_found", "Not found");
  return row;
}

const SYSTEM: AuditActor = { kind: "system", id: null };

/**
 * The actor of a system or directory-sync member change: may act on an org
 * owner or admin. Always passed explicitly (#475): the actor is a required
 * argument, so a forgotten one is a type error, never a fail-open default.
 */
export const SYSTEM_ACTOR: unique symbol = Symbol("oa.system-actor");
/** Who changes a member: the signed-in member (routes) or SYSTEM_ACTOR. */
export type MemberActor = Member | typeof SYSTEM_ACTOR;

/**
 * 1 when `actor` may act on an org owner or admin (#475), else 0: the flag
 * every guarded write binds. SYSTEM_ACTOR (system, directory sync) may.
 */
const adminsOk = (actor: MemberActor): 0 | 1 =>
  actor === SYSTEM_ACTOR || managesAdmins(actor) ? 1 : 0;

/** The audit actor: the member, else system (sync for directory reasons). */
const auditActor = (actor: MemberActor, why?: AuditReason): AuditActor =>
  actor === SYSTEM_ACTOR ? (why ? actorFor(why) : SYSTEM) : userActor(actor.id);

const ownerOnly = () =>
  new ApiError("owner_only", "Only the owner can manage an owner or admin");

/** Precheck: an org owner or admin target needs the owner (403 owner_only). */
function checkTarget(role: string, admins: 0 | 1): void {
  if (!admins && isOrgAdmin(role)) throw ownerOnly();
}

const GUARDED_TARGET =
  "select 1 from users where id = ?1 and role in ('owner', 'admin')";

/**
 * After a guarded write changed nothing: 403 owner_only when the target is
 * (now) an owner or admin the actor may not act on, e.g. promoted between the
 * precheck and the batch.
 */
async function raceCheck(env: Env, id: string, admins: 0 | 1): Promise<void> {
  if (admins) return;
  if (await stmt(env.DB, GUARDED_TARGET).bind(id).first()) throw ownerOnly();
}

/** A system change's audit actor: sync for directory reasons. */
function actorFor(why: AuditReason): AuditActor {
  return why.startsWith("directory_") ? { kind: "sync", id: null } : SYSTEM;
}

// One statement per status change. A removed row stays removed, and the
// instance owner is never deactivated. Any change ends every session
// (session_epoch), so a cookie minted before a suspension never comes back.
// A lapsed guest (removed because their last share went, guest_lapsed = 1)
// can still be removed for good: that clears guest_lapsed, so a later share
// no longer revives them (putShare).
// An admin row only when ?4 = 1 (the actor may act on admins, #475).
const SET_STATUS = `update users set status = ?2, guest_lapsed = 0, status_changed_at = ?3,
  session_epoch = session_epoch + 1
  where id = ?1 and role <> 'owner' and (role <> 'admin' or ?4 = 1)
  and ((status <> ?2 and status <> 'removed')
    or (?2 = 'removed' and status = 'removed' and guest_lapsed = 1))`;
// Only for a deactivation, and only while the row now has that status (never
// on an unsuspend or a no-op, never the owner's PATs, an admin's only when
// ?4 = 1).
const REVOKE_PATS = `update tokens set revoked_at = ?2
  where user_id = ?1 and revoked_at is null and ?3 <> 'active'
  and exists (select 1 from users where id = ?1 and status = ?3
    and (role <> 'admin' or ?4 = 1))`;
const STATUS_OF = "select status from users where id = ?1";

/**
 * Sets a user's status (P3 T6). The write, the PAT revocation and the
 * user.status audit row (only when the status changed) commit in one D1
 * batch. When the user is now suspended or removed, their OAuth grants are
 * revoked (KV, after the gated batch, so a refused target keeps them) and
 * then their live sockets close
 * (revokeUserLive). Unsuspending sets the status back to active; the PATs
 * and sessions the suspension revoked stay revoked. A removed row stays
 * removed. getUser resolves only active rows, so every credential stops at
 * the next request.
 *
 * `actor` is the member acting (routes; audited as them) or SYSTEM_ACTOR
 * (system and directory sync). An admin may not suspend or remove an owner
 * or admin, 403 owner_only, enforced in the write so a promotion racing the
 * call changes nothing (#475).
 */
export async function setUserStatus(
  env: Env,
  userId: string,
  status: MemberStatus,
  why: AuditReason,
  actor: MemberActor,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const admins = adminsOk(actor);
  const by = auditActor(actor, why);
  const out = await env.DB.batch([
    stmt(env.DB, SET_STATUS).bind(userId, status, Date.now(), admins),
    // Directly after the update: audited only when it changed the row.
    audit(env, "user.status", { type: "user", id: userId }, by, {
      reason: why,
      detail: { status },
      when: { sql: "changes() > 0", args: [] },
    }),
    stmt(env.DB, REVOKE_PATS).bind(userId, Date.now(), status, admins),
    stmt(env.DB, STATUS_OF).bind(userId),
  ]);
  if (!out[0]?.meta.changes) await raceCheck(env, userId, admins);
  const now = (out[3]?.results[0] as { status?: string } | undefined)?.status;
  if (status === "active" || now !== status) return;
  try {
    // A grant this misses (KV listing lag) is still refused: it was issued
    // before status_changed_at (oauth.ts apiHandler).
    await revokeAllGrants(env, userId);
  } finally {
    // Sessions and PATs are gone: their live sockets close now (P3 T7), even
    // when the grant revocation failed.
    await revokeUserLive(env, userId, `user ${status}`, ctx);
  }
}

// The target predicate both role statements share: never the owner, an admin
// only when ?3 = 1 (the actor may act on admins, #475).
const ROLE_TARGET = "role <> 'owner' and (role <> 'admin' or ?3 = 1)";

// A role change ends the member's sessions (they re-sign-in with the new role).
const SET_ROLE = `update users set role = ?2, session_epoch = session_epoch + 1
  where id = ?1 and ${ROLE_TARGET}
  returning id, email, name, display_name as displayName, role, last_seen_at as lastSeenAt`;

// Runs before SET_ROLE, on its new role (?2), so both share one target check.
const CLEAR_MANUAL_RESTRICTION = `update users set restricted_manual = 0
  where id = ?1 and ?2 = 'admin' and restricted_manual <> 0 and ${ROLE_TARGET}`;

/**
 * Changes a member's role. `actor` is the member acting (routes; audited as
 * them) or SYSTEM_ACTOR. An admin may not change an owner's or admin's role,
 * 403 owner_only, enforced in the write so a promotion racing the call
 * changes nothing (#475).
 */
export async function patchMember(
  env: Env,
  id: string,
  patch: MemberPatch,
  actor: MemberActor,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<Member> {
  const row = await getRow(env, id);
  const admins = adminsOk(actor);
  const by = auditActor(actor);
  checkTarget(row.role, admins);
  if (row.role === "owner")
    throw new ApiError("bad_request", "The owner cannot be demoted");
  const db = getDb(env);
  const results = await env.DB.batch([
    // Owners and admins can't be restricted (ruling c): a promotion to admin
    // clears the manual flag too, audited restricted.remove when it was set.
    stmt(env.DB, CLEAR_MANUAL_RESTRICTION).bind(id, patch.role, admins),
    audit(env, "restricted.remove", { type: "user", id }, by, {
      when: { sql: "changes() > 0", args: [] },
    }),
    // Audited as user.role in the same batch, only when the role changes.
    stmt(env.DB, SET_ROLE).bind(id, patch.role, admins),
    audit(env, "user.role", { type: "user", id }, by, {
      detail: { from: row.role, to: patch.role },
      when: { sql: "changes() > 0 and ? <> ?", args: [row.role, patch.role] },
    }),
    // The group restriction depends on the role (never owners or admins):
    // a demoted admin in a restricted group is capped now, a promoted
    // member no longer is (P3 T9).
    stmt(env.DB, RESTRICTED_SYNC_FOR_USER).bind(id),
  ]);
  const out = results[2]?.results[0] as
    | Parameters<typeof toMember>[0]
    | undefined;
  if (!out) {
    await raceCheck(env, id, admins);
    throw new ApiError("not_found", "Not found");
  }
  // Sessions ended above; live sockets were authorized under the old role
  // (and a raised restriction cap): close them too (P3 T7).
  await revokeUserLive(env, id, "role changed", ctx);
  // Guests can't connect agents: a demotion revokes their PATs and OAuth grants.
  // (MemberPatch allows only admin|member today; this guards a wider contract.)
  const role: string = patch.role;
  if (role === "guest") {
    await db
      .update(tokens)
      .set({ revokedAt: Date.now() })
      .where(and(eq(tokens.userId, id), isNull(tokens.revokedAt)));
    await revokeAllGrants(env, id);
  }
  return toMember(out);
}

/**
 * With FEATURES `spaces` on (P3 T6), the member's status becomes `removed`
 * (setUserStatus, audited). The row, their personal space and everything in
 * it stay: personal artifacts wait for an admin transfer, and shared-space
 * artifacts stay in their spaces.
 *
 * Otherwise the user row is removed in one D1 batch with its user.status
 * audit row (admin_remove), so both commit or neither does. Their personal-space
 * artifacts move to the instance owner's personal space. Shared-space
 * artifacts keep their space (#478); only owner_id moves, because it must
 * name a user and it grants nothing in a shared space. Every other row that
 * references them is reassigned to the instance owner; their tokens are
 * deleted (tokens.user_id has no cascade, so revoked rows would block the
 * delete). Shares addressed to their email are kept.
 *
 * `actor` is the member acting (routes; audited as them) or SYSTEM_ACTOR. An
 * admin may not remove an owner or admin, 403 owner_only, enforced in the
 * writes too (#475).
 */
export async function removeMember(
  env: Env,
  id: string,
  actor: MemberActor,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const row = await getRow(env, id);
  checkTarget(row.role, adminsOk(actor));
  if (row.role === "owner")
    throw new ApiError("bad_request", "The owner cannot be removed");
  const db = getDb(env);
  if (authConfig(env).features.includes("spaces"))
    await setUserStatus(env, id, "removed", "admin_remove", actor, ctx);
  else await deleteMember(env, id, actor, ctx);
  // Belt and braces for the artifacts shared with them (best effort, capped).
  const shared = await db
    .select({ id: shares.artifactId })
    .from(shares)
    .where(eq(shares.email, row.email))
    .limit(MAX_CLOSE);
  await closeRuntimeSockets(
    env,
    shared.map((r) => r.id),
    "member removed",
    ctx,
  );
}

/**
 * removeMember with the spaces flag off: the row goes (see removeMember),
 * audited as user.status (admin_remove) in the same batch. Every statement
 * is gated on the target still being one the actor may remove, so a target
 * promoted to admin before the batch is 403 owner_only and nothing in D1
 * changes (#475). Their OAuth grants (KV) are revoked after the batch, so a
 * refused target keeps them (#553).
 */
async function deleteMember(
  env: Env,
  id: string,
  actor: MemberActor,
  ctx: Pick<ExecutionContext, "waitUntil"> | undefined,
): Promise<void> {
  const db = getDb(env);
  const admins = adminsOk(actor);
  const by = auditActor(actor);
  // As ROLE_TARGET: never the owner, an admin only when the actor may.
  const target = sql`exists (select 1 from users u where u.id = ${id}
    and u.role <> 'owner' and (u.role <> 'admin' or ${admins} = 1))`;
  const owner = (
    await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "owner"))
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(1)
  )[0];
  if (!owner) throw new ApiError("bad_request", "No owner to reassign to");
  const to = owner.id;
  // Personal-space artifacts (space_id = their id) move into the instance
  // owner's personal space; shared-space ones keep their space_id (#478).
  const move = {
    ownerId: to,
    spaceId: sql`case when ${artifacts.spaceId} = ${id} then ${to} else ${artifacts.spaceId} end`,
  };
  // Raw D1 statements, so the audit() statement joins the same batch: the
  // removal and its user.status row commit together or not at all.
  const raw = (q: { toSQL(): { sql: string; params: unknown[] } }) => {
    const { sql: text, params } = q.toSQL();
    return env.DB.prepare(text).bind(...params);
  };
  const writes = [
    // Split live/deleted: owner_id is only indexed by the two partial indexes (#248).
    db
      .update(artifacts)
      .set(move)
      .where(
        and(eq(artifacts.ownerId, id), isNull(artifacts.deletedAt), target),
      ),
    db
      .update(artifacts)
      .set(move)
      .where(
        and(eq(artifacts.ownerId, id), isNotNull(artifacts.deletedAt), target),
      ),
    // The personal space's id IS its owner's user id, so re-pointing it would
    // leave a row named after the removed user and owned by the instance owner.
    // It is empty by now (the artifacts above moved), so drop it; ownership is
    // the id, never owner_user_id.
    db
      .delete(spaces)
      .where(and(eq(spaces.id, id), eq(spaces.kind, "personal"), target)),
    db
      .update(versions)
      .set({ createdBy: to })
      .where(and(eq(versions.createdBy, id), target)),
    db
      .update(shares)
      .set({ createdBy: to })
      .where(and(eq(shares.createdBy, id), target)),
    db
      .update(uploads)
      .set({ userId: to })
      .where(and(eq(uploads.userId, id), target)),
    db
      .update(reservedArtifacts)
      .set({ userId: to })
      .where(and(eq(reservedArtifacts.userId, id), target)),
    db.delete(tokens).where(and(eq(tokens.userId, id), target)),
    // Grant usage rows reference the user (their grants are revoked above).
    db.delete(agentGrants).where(and(eq(agentGrants.userId, id), target)),
    db.delete(identities).where(and(eq(identities.userId, id), target)),
  ];
  const out = await env.DB.batch([
    ...writes.map(raw),
    // Before the row goes, and only while it exists (a concurrent removal
    // writes one row). The target id stays; the actor's email is joined at
    // read time, so a deleted target only reads back without one.
    audit(env, "user.status", { type: "user", id }, by, {
      reason: "admin_remove",
      detail: { status: "removed" },
      when: {
        sql: "exists (select 1 from users where id = ? and role <> 'owner' and (role <> 'admin' or ? = 1))",
        args: [id, admins],
      },
    }),
    raw(db.delete(users).where(and(eq(users.id, id), target))),
  ]);
  if (!out.at(-1)?.meta.changes) await raceCheck(env, id, admins);
  try {
    // OAuth grants live in KV, outside the batch: revoked only once the
    // gated batch went through, so a target refused mid-request (promoted
    // to admin) keeps theirs (#553). One this misses is still refused: it
    // names a user row that is gone (oauth.ts apiHandler).
    await revokeAllGrants(env, id);
  } finally {
    // Every live socket the member holds (team artifacts included) closes
    // through their UserPresence (P3 T7); it never throws.
    await revokeUserLive(env, id, "member removed", ctx);
  }
}

const DEFAULT_SETTINGS: Settings = {
  name: "Open Artifacts",
  defaultVisibility: "private",
};
const KEY = { name: "name", defaultVisibility: "default_visibility" } as const;

const SETTINGS_ALL = "select key, value from settings";

/** Every settings row (one prepared D1 statement); /me also reads the
 * latest-release row from it, so that costs no extra query. */
export async function getSettingsKv(env: Env): Promise<Map<string, string>> {
  const { results: rows } = await stmt(env.DB, SETTINGS_ALL).all<{
    key: string;
    value: string;
  }>();
  return new Map(rows.map((r) => [r.key, r.value]));
}

export function toSettings(kv: Map<string, string>): Settings {
  const name = kv.get(KEY.name);
  const vis = kv.get(KEY.defaultVisibility);
  return {
    name: name && name.length <= 80 ? name : DEFAULT_SETTINGS.name,
    defaultVisibility:
      vis === "private" || vis === "team"
        ? vis
        : DEFAULT_SETTINGS.defaultVisibility,
  };
}

/** Every publish and /me: one prepared D1 statement. */
export async function getSettings(env: Env): Promise<Settings> {
  return toSettings(await getSettingsKv(env));
}

/** Settings row for the hosted spaceManagerMappings flag (absent = true). */
export const SPACE_MANAGER_MAPPINGS_KEY = "space_manager_mappings";

/**
 * GET R.settings: the instance settings, plus spaceManagerMappings (default
 * true) when the spaces feature is on; absent otherwise, so self-hosted
 * installs keep today's shape.
 */
export async function settingsView(
  env: Env,
  spaces: boolean,
): Promise<Settings> {
  const kv = await getSettingsKv(env);
  const s = toSettings(kv);
  return spaces
    ? {
        ...s,
        spaceManagerMappings: kv.get(SPACE_MANAGER_MAPPINGS_KEY) !== "false",
      }
    : s;
}

const UPSERT_SETTING = `insert into settings (key, value) values (?1, ?2)
  on conflict (key) do update set value = excluded.value`;

/**
 * Writes the patch in one batch. spaceManagerMappings is written only with
 * the spaces feature on, audited settings.space_manager_mappings in the same
 * batch and only when it changes.
 */
export async function patchSettings(
  env: Env,
  patch: SettingsPatch,
  opts: { spaces?: boolean; by?: AuditActor } = {},
): Promise<Settings> {
  const writes = (Object.keys(KEY) as (keyof typeof KEY)[])
    .filter((k) => patch[k] !== undefined)
    .map((k) => stmt(env.DB, UPSERT_SETTING).bind(KEY[k], String(patch[k])));
  const smm = patch.spaceManagerMappings;
  if (opts.spaces && smm !== undefined)
    writes.push(
      audit(
        env,
        "settings.space_manager_mappings",
        { type: "directory", id: "settings" },
        opts.by ?? SYSTEM,
        {
          detail: { spaceManagerMappings: smm },
          when: {
            sql: "coalesce((select value from settings where key = ?), 'true') <> ?",
            args: [SPACE_MANAGER_MAPPINGS_KEY, String(smm)],
          },
        },
      ),
      stmt(env.DB, UPSERT_SETTING).bind(
        SPACE_MANAGER_MAPPINGS_KEY,
        String(smm),
      ),
    );
  if (writes.length) await env.DB.batch(writes);
  return settingsView(env, opts.spaces === true);
}
