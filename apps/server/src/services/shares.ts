import { normalizeEmail } from "@oa/auth-core";
import {
  type Format,
  type Member,
  type Share,
  type ShareResult,
  type ShareRole,
  viewerPath,
} from "@oa/shared";
import { asc, eq } from "drizzle-orm";
import { authorize, callerOf } from "../auth/authz.js";
import { getDb } from "../db/client.js";
import { shares } from "../db/schema.js";
import { stmt } from "../db/stmt.js";
import { emailEnabled, sendEmail } from "../email/send.js";
import { senderName, shareEmail } from "../email/templates.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { logInfo, logWarn } from "../log.js";
import { revokeAllGrants } from "../mcp/oauth-api.js";
import { closeRuntimeSockets, revokeUserLive } from "../runtime/revoke.js";
import { audit, userActor } from "./audit.js";
import { getSettings } from "./members.js";

export const MAX_SHARES = 200;

const toShare = (r: {
  email: string;
  role: string;
  createdAt: number;
}): Share => ({
  email: r.email,
  role: r.role as ShareRole,
  createdAt: new Date(r.createdAt).toISOString(),
});

const ownerOnly = (
  env: Env,
  user: Member,
  id: string,
  action: "share" | "unshare" = "share",
) => authorize(env, callerOf(user), id, action).then((r) => r.artifact);

export async function listShares(
  env: Env,
  user: Member,
  id: string,
): Promise<Share[]> {
  await ownerOnly(env, user, id);
  const rows = await getDb(env)
    .select()
    .from(shares)
    .where(eq(shares.artifactId, id))
    .orderBy(asc(shares.createdAt), asc(shares.email))
    .limit(MAX_SHARES);
  return rows.map(toShare);
}

/**
 * artifact.share / artifact.unshare for the change's batch, placed right
 * after it: written only when that statement changed a row. The grantee's
 * address is never recorded.
 */
const shareAudit = (
  env: Env,
  action: "artifact.share" | "artifact.unshare",
  user: Member,
  artifact: { id: string; spaceId: string | null },
  detail: Record<string, unknown>,
) =>
  audit(
    env,
    action,
    { type: "artifact", id: artifact.id },
    userActor(user.id),
    {
      spaceId: artifact.spaceId,
      detail,
      when: { sql: "changes() > 0", args: [] },
    },
  );

const SAME_SHARE =
  "SELECT email, role, created_at AS createdAt FROM shares WHERE artifact_id = ? AND email = ? AND role = ?";
const IS_USER = "select 1 as x from users where email = ? limit 1";
// Only a lapsed guest (removed by the last-share cleanup): an admin or
// directory removal clears guest_lapsed and stays removed (P3 T6).
const REACTIVATE_GUEST =
  "update users set status = 'active', guest_lapsed = 0, status_changed_at = ?2 where email = ?1 and role = 'guest' and status = 'removed' and guest_lapsed = 1";

/**
 * user.status for a guest lapsing (last share gone) or coming back (a new
 * share), right after that statement in its batch: written only when the
 * statement changed the row. The actor is the member whose share change
 * caused it. No reason (AuditReason has none for shares); ids only.
 */
const lapseAudit = (
  env: Env,
  guestId: string,
  status: "removed" | "active",
  actorId: string,
) =>
  audit(env, "user.status", { type: "user", id: guestId }, userActor(actorId), {
    detail: { status, cause: status === "removed" ? "last_share" : "share" },
    when: { sql: "changes() > 0", args: [] },
  });

/**
 * Upsert (owner-only). Sharing only ever adds access; see accessLevel.
 * A new share with a non-member is emailed a link (best effort).
 */
export async function putShare(
  env: Env,
  user: Member,
  id: string,
  s: { email: string; role: ShareRole },
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<ShareResult> {
  const artifact = await ownerOnly(env, user, id);
  const email = normalizeEmail(s.email);
  if (!email) throw new ApiError("bad_request", "Invalid email");
  if (email === normalizeEmail(user.email))
    throw new ApiError("bad_request", "Cannot share with yourself");
  const now = Date.now();
  // One atomic statement: a new email is inserted only while under the cap;
  // updating an existing share bypasses it, and the same role is a no-op.
  // The audit row rides in the same batch, written only when the upsert
  // changed a row (a share refused at the cap, or a re-share at the same
  // role, writes none).
  const [res] = await env.DB.batch<{
    email: string;
    role: string;
    createdAt: number;
  }>([
    env.DB.prepare(
      `INSERT INTO shares (artifact_id, email, role, created_by, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5
       WHERE (SELECT count(*) FROM shares WHERE artifact_id = ?1) < ?6
          OR EXISTS (SELECT 1 FROM shares WHERE artifact_id = ?1 AND email = ?2)
       ON CONFLICT (artifact_id, email) DO UPDATE SET role = excluded.role
         WHERE shares.role <> excluded.role
       RETURNING email, role, created_at AS createdAt`,
    ).bind(id, email, s.role, user.id, now, MAX_SHARES),
    shareAudit(env, "artifact.share", user, artifact, { role: s.role }),
  ]);
  // No row back: unchanged (already at this role) or refused at the cap.
  const row =
    res?.results[0] ??
    (await stmt(env.DB, SAME_SHARE)
      .bind(id, email, s.role)
      .first<{ email: string; role: string; createdAt: number }>());
  if (!row)
    throw new ApiError(
      "bad_request",
      `At most ${MAX_SHARES} shares per artifact`,
    );
  // An update keeps the original created_at, so this is a new share.
  const created = row.createdAt === now;
  // A changed share at viewer is a downgrade from editor: the sockets opened
  // as editor close, and the artifact's DO refuses accepts authorized before
  // it (P3 T7). Not the person's presence: their other artifacts are unaffected.
  if (res?.results[0] && !created && s.role === "viewer")
    await closeRuntimeSockets(env, [id], "share narrowed", ctx);
  // A guest deactivated when their last share went comes back on a new one
  // (same row: their history and name are intact). After the insert, so a
  // concurrent cleanup either sees this share or is undone here.
  // Audited (user.status, active) in the same batch, only when it happened.
  if (created) {
    const guest = await stmt(env.DB, GUEST_ID)
      .bind(email)
      .first<{ id: string }>();
    if (guest)
      await env.DB.batch([
        stmt(env.DB, REACTIVATE_GUEST).bind(email, Date.now()),
        lapseAudit(env, guest.id, "active", user.id),
      ]);
  }
  return {
    ...toShare(row),
    emailed: created && (await emailShare(env, user, artifact, email, s.role)),
  };
}

async function emailShare(
  env: Env,
  user: Member,
  artifact: { id: string; title: string; format: string },
  email: string,
  role: ShareRole,
): Promise<boolean> {
  if (!emailEnabled(env)) return false;
  try {
    const [member, settings] = await Promise.all([
      stmt(env.DB, IS_USER).bind(email).first(),
      getSettings(env),
    ]);
    if (member) return false;
    return await sendEmail(
      env,
      user.id,
      email,
      () =>
        shareEmail({
          inviter: senderName(user),
          instance: settings.name,
          recipient: email,
          appHost: env.APP_HOST,
          title: artifact.title,
          path: viewerPath(artifact.id),
          format: artifact.format as Format,
          role,
        }),
      {
        kind: "share",
        artifactId: artifact.id,
        instance: settings.name,
        replyTo: normalizeEmail(user.email) ?? undefined,
      },
    );
  } catch {
    return false;
  }
}

export async function deleteShare(
  env: Env,
  user: Member,
  id: string,
  email: string,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const artifact = await ownerOnly(env, user, id, "unshare");
  const e = normalizeEmail(email);
  if (!e) throw new ApiError("not_found", "Not found");
  const [out] = await env.DB.batch([
    stmt(
      env.DB,
      "DELETE FROM shares WHERE artifact_id = ? AND email = ? RETURNING email",
    ).bind(id, e),
    shareAudit(env, "artifact.unshare", user, artifact, {}),
  ]);
  if (!out?.results.length) throw new ApiError("not_found", "Not found");
  // Closes the artifact's sockets and records the change in its DO, so a
  // socket authorized before it is refused on accept (P3 T7). Not the
  // person's presence: their sockets on other artifacts are unaffected.
  await closeRuntimeSockets(env, [id], "share revoked", ctx);
  // Best effort: the share is already gone, and that is what the caller asked.
  // A guest left with no share is deactivated, which revokes their presence.
  const log = { artifactId: id, actorId: user.id };
  await removeGuestIfUnshared(env, e, log, ctx).catch((err) =>
    logWarn("guest_cleanup_failed", err, {
      ...log,
      reason: err instanceof ApiError ? err.code : "error",
    }),
  );
}

// Every statement re-checks "still a guest, still no share, still in no
// space" itself, so the batch is atomic against a concurrent promotion,
// putShare or space grant. A guest who holds a space role (the API or
// directory sync added them) keeps their account when their last share goes
// (review item 18).
const UNSHARED_GUEST =
  "email = ?1 AND role = 'guest' AND NOT EXISTS (SELECT 1 FROM shares WHERE email = ?1) AND NOT EXISTS (SELECT 1 FROM space_members sm WHERE sm.user_id = users.id)";
const GUEST_ID = "select id from users where email = ? and role = 'guest'";
const DEACTIVATE_GUEST = `UPDATE users SET status = 'removed', guest_lapsed = 1, status_changed_at = ?2,
   session_epoch = session_epoch + 1
   WHERE ${UNSHARED_GUEST} AND status = 'active' RETURNING id`;
const DELETE_GUEST_TOKENS = `DELETE FROM tokens WHERE user_id IN
   (SELECT id FROM users WHERE ${UNSHARED_GUEST} AND status = 'removed')`;

/**
 * A guest exists only through shares: once the last share to their address
 * goes, the guest is deactivated (status 'removed', sessions ended, PATs and
 * OAuth grants revoked). The row stays, so the versions they authored and
 * their display name are kept; a new share reactivates it (putShare).
 *
 * Follow-up: purge's cascading share deletes, and a guest whose only shares
 * are on trashed artifacts, should run this same cleanup.
 */
export async function removeGuestIfUnshared(
  env: Env,
  email: string,
  log: { artifactId: string; actorId: string },
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
  const guest = await stmt(env.DB, GUEST_ID)
    .bind(email)
    .first<{ id: string }>();
  if (!guest) return;
  const [deactivated] = await env.DB.batch<{ id: string }>([
    stmt(env.DB, DEACTIVATE_GUEST).bind(email, Date.now()),
    // Directly after the deactivation: audited only when it happened.
    lapseAudit(env, guest.id, "removed", log.actorId),
    stmt(env.DB, DELETE_GUEST_TOKENS).bind(email),
  ]);
  const id = deactivated?.results[0]?.id;
  if (!id) return;
  // Their live sockets close now (P3 T7); never throws.
  await revokeUserLive(env, id, "guest removed", ctx);
  // OAuth grants live in KV, outside the batch.
  await revokeAllGrants(env, id);
  logInfo("guest_removed", log);
}
