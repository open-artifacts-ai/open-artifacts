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
import { authConfig } from "../auth/config.js";
import { getDb } from "../db/client.js";
import {
  artifacts,
  identities,
  reservedArtifacts,
  settings,
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
import { type AuditActor, audit } from "./audit.js";
import { insertUser, toMember } from "./users.js";

export async function listMembers(env: Env): Promise<Member[]> {
  const rows = await getDb(env)
    .select()
    .from(users)
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
      { kind: "invite", replyTo: normalizeEmail(inviter.email) ?? undefined },
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

/** The audit actor when none is given: sync for directory reasons. */
const actorFor = (why: AuditReason): AuditActor =>
  why.startsWith("directory_") ? { kind: "sync", id: null } : SYSTEM;

// One statement per status change. A removed row stays removed, and the
// instance owner is never deactivated. Any change ends every session
// (session_epoch), so a cookie minted before a suspension never comes back.
const SET_STATUS = `update users set status = ?2, session_epoch = session_epoch + 1
  where id = ?1 and status <> ?2 and status <> 'removed' and role <> 'owner'`;
// Only while the row now has the deactivated status (never the owner's PATs).
const REVOKE_PATS = `update tokens set revoked_at = ?2
  where user_id = ?1 and revoked_at is null
  and exists (select 1 from users where id = ?1 and status = ?3)`;
const STATUS_OF = "select status from users where id = ?1";

/**
 * Sets a user's status (P3 T6). The write, the PAT revocation and the
 * user.status audit row (only when the status changed) commit in one D1
 * batch. When the user is now suspended or removed, their OAuth grants are
 * revoked (KV, outside the batch) and then their live sockets close
 * (revokeUserLive). Unsuspending sets the status back to active; the PATs
 * and sessions the suspension revoked stay revoked. A removed row stays
 * removed. getUser resolves only active rows, so every credential stops at
 * the next request.
 */
export async function setUserStatus(
  env: Env,
  userId: string,
  status: MemberStatus,
  why: AuditReason,
  ctx?: Pick<ExecutionContext, "waitUntil">,
  by: AuditActor = actorFor(why),
): Promise<void> {
  const out = await env.DB.batch([
    stmt(env.DB, SET_STATUS).bind(userId, status),
    // Directly after the update: audited only when it changed the row.
    audit(env, "user.status", { type: "user", id: userId }, by, {
      reason: why,
      detail: { status },
      when: { sql: "changes() > 0", args: [] },
    }),
    stmt(env.DB, REVOKE_PATS).bind(userId, Date.now(), status),
    stmt(env.DB, STATUS_OF).bind(userId),
  ]);
  const now = (out[3]?.results[0] as { status?: string } | undefined)?.status;
  if (status === "active" || now !== status) return;
  await revokeAllGrants(env, userId);
  // Sessions, PATs and grants are gone: their live sockets close now (P3 T7).
  await revokeUserLive(env, userId, `user ${status}`, ctx);
}

// A role change ends the member's sessions (they re-sign-in with the new role).
const SET_ROLE = `update users set role = ?2, session_epoch = session_epoch + 1
  where id = ?1 and role <> 'owner'
  returning id, email, name, display_name as displayName, role, last_seen_at as lastSeenAt`;

export async function patchMember(
  env: Env,
  id: string,
  patch: MemberPatch,
  ctx?: Pick<ExecutionContext, "waitUntil">,
  by: AuditActor = SYSTEM,
): Promise<Member> {
  const row = await getRow(env, id);
  if (row.role === "owner")
    throw new ApiError("bad_request", "The owner cannot be demoted");
  const db = getDb(env);
  // Audited as user.role in the same batch, only when the role changes.
  const [res] = await env.DB.batch([
    stmt(env.DB, SET_ROLE).bind(id, patch.role),
    audit(env, "user.role", { type: "user", id }, by, {
      detail: { from: row.role, to: patch.role },
      when: { sql: "changes() > 0 and ? <> ?", args: [row.role, patch.role] },
    }),
  ]);
  const out = res?.results[0] as Parameters<typeof toMember>[0] | undefined;
  if (!out) throw new ApiError("not_found", "Not found");
  // Sessions ended above; live sockets were authorized under the old role:
  // close them too (P3 T7).
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
 * Otherwise the user row is removed in one D1 batch. Their personal-space
 * artifacts move to the instance owner's personal space. Shared-space
 * artifacts keep their space (#478); only owner_id moves, because it must
 * name a user and it grants nothing in a shared space. Every other row that
 * references them is reassigned to the instance owner; their tokens are
 * deleted (tokens.user_id has no cascade, so revoked rows would block the
 * delete). Shares addressed to their email are kept.
 */
export async function removeMember(
  env: Env,
  id: string,
  ctx?: Pick<ExecutionContext, "waitUntil">,
  by: AuditActor = SYSTEM,
): Promise<void> {
  const row = await getRow(env, id);
  if (row.role === "owner")
    throw new ApiError("bad_request", "The owner cannot be removed");
  const db = getDb(env);
  if (authConfig(env).features.includes("spaces"))
    await setUserStatus(env, id, "removed", "admin_remove", ctx, by);
  else await deleteMember(env, id, ctx);
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

/** removeMember with the spaces flag off: the row goes (see removeMember). */
async function deleteMember(
  env: Env,
  id: string,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const db = getDb(env);
  const owner = (
    await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "owner"))
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(1)
  )[0];
  if (!owner) throw new ApiError("bad_request", "No owner to reassign to");
  // OAuth grants live in KV, outside the batch: revoke them first.
  await revokeAllGrants(env, id);
  const to = owner.id;
  // Personal-space artifacts (space_id = their id) move into the instance
  // owner's personal space; shared-space ones keep their space_id (#478).
  const move = {
    ownerId: to,
    spaceId: sql`case when ${artifacts.spaceId} = ${id} then ${to} else ${artifacts.spaceId} end`,
  };
  await db.batch([
    // Split live/deleted: owner_id is only indexed by the two partial indexes (#248).
    db
      .update(artifacts)
      .set(move)
      .where(and(eq(artifacts.ownerId, id), isNull(artifacts.deletedAt))),
    db
      .update(artifacts)
      .set(move)
      .where(and(eq(artifacts.ownerId, id), isNotNull(artifacts.deletedAt))),
    // The personal space's id IS its owner's user id, so re-pointing it would
    // leave a row named after the removed user and owned by the instance owner.
    // It is empty by now (the artifacts above moved), so drop it; ownership is
    // the id, never owner_user_id.
    db
      .delete(spaces)
      .where(and(eq(spaces.id, id), eq(spaces.kind, "personal"))),
    db
      .update(versions)
      .set({ createdBy: to })
      .where(eq(versions.createdBy, id)),
    db.update(shares).set({ createdBy: to }).where(eq(shares.createdBy, id)),
    db.update(uploads).set({ userId: to }).where(eq(uploads.userId, id)),
    db
      .update(reservedArtifacts)
      .set({ userId: to })
      .where(eq(reservedArtifacts.userId, id)),
    db.delete(tokens).where(eq(tokens.userId, id)),
    db.delete(identities).where(eq(identities.userId, id)),
    db.delete(users).where(eq(users.id, id)),
  ]);
  // Every live socket the member holds (team artifacts included) closes
  // through their UserPresence (P3 T7); it never throws.
  await revokeUserLive(env, id, "member removed", ctx);
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

export async function patchSettings(
  env: Env,
  patch: SettingsPatch,
): Promise<Settings> {
  const db = getDb(env);
  const writes = (Object.keys(KEY) as (keyof typeof KEY)[])
    .filter((k) => patch[k] !== undefined)
    .map((k) =>
      db
        .insert(settings)
        .values({ key: KEY[k], value: String(patch[k]) })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: String(patch[k]) },
        }),
    );
  const [first, ...rest] = writes;
  if (first) await db.batch([first, ...rest]);
  return getSettings(env);
}
