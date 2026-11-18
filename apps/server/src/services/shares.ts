import { normalizeEmail } from "@oa/auth-core";
import {
  type Member,
  type Role,
  type Share,
  type ShareRecipient,
  type ShareResult,
  type ShareRole,
  viewerPath,
} from "@oa/shared";
import { asc, eq } from "drizzle-orm";
import {
  authorize,
  callerOf,
  planOfMember,
  suspendedMember,
} from "../auth/authz.js";
import { authConfig, type SignInProvider } from "../auth/config.js";
import { capOf, isCommenterRole } from "../auth/policy.js";
import { requireTeamPlan } from "../billing/plan.js";
import { getDb } from "../db/client.js";
import { shares, users } from "../db/schema.js";
import {
  SHARE_ROLE_CASE,
  shareRoleSql,
  storedShare,
} from "../db/share-role.js";
import { stmt } from "../db/stmt.js";
import { emailEnabled, sendEmail } from "../email/send.js";
import {
  addressHash,
  optoutUrl,
  signOptoutToken,
} from "../email/share-optout.js";
import {
  outsideShareEmail,
  senderName,
  shareEmail,
} from "../email/templates.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { logInfo, logWarn } from "../log.js";
import { revokeAllGrants } from "../mcp/oauth-api.js";
import { closeRuntimeSockets, revokeUserLive } from "../runtime/revoke.js";
import { audit, userActor } from "./audit.js";
import { apiFormat } from "./doc-format.js";
import { inBackground, notifyShared } from "./follows.js";
import { recordShareItem } from "./inbox-items.js";
import { getSettings } from "./members.js";
import { outsideAddress, outsideSharingOn } from "./outside.js";
import { guestRecipients, shareReach } from "./reach.js";

export const MAX_SHARES = 200;

/**
 * What a guest's share comes to, in words. Copy only: access is decided in
 * src/auth. A stored editor gets edit back if they become a member.
 */
const GUEST_LINE: Record<ShareRole, string> = {
  viewer: "They're a guest, so they can only view.",
  commenter: "They're a guest, so they can view and comment.",
  editor: "They're a guest, so they can only view for now.",
};
export const guestShareLine = (s: { role: ShareRole }): string =>
  GUEST_LINE[s.role];

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
    .select({
      email: shares.email,
      role: shareRoleSql(),
      createdAt: shares.createdAt,
      orgRole: users.role,
      rm: users.restrictedManual,
      rs: users.restrictedSync,
    })
    .from(shares)
    .leftJoin(users, eq(users.email, shares.email))
    .where(eq(shares.artifactId, id))
    .orderBy(asc(shares.createdAt), asc(shares.email))
    .limit(MAX_SHARES);
  const isGuest = guestRecipients(env);
  const cfg = authConfig(env);
  // Access's own cap (capOf), so a member who can only view says so. Never
  // why: a row has no user, or no cap, and the field is absent.
  const viewOnly = (r: (typeof rows)[number]) =>
    r.orgRole !== null &&
    capOf(
      {
        role: r.orgRole as Role,
        // Fail closed, as getUser reads them: any non-zero flag restricts.
        restrictedManual: (r.rm ?? 0) !== 0,
        restrictedSync: (r.rs ?? 0) !== 0,
      },
      cfg,
    ) !== null;
  return Promise.all(
    rows.map(async (r) => ({
      ...toShare(r),
      ...((await isGuest(r.email, r.orgRole)) ? { guest: true } : {}),
      ...(viewOnly(r) && !isCommenterRole(r.role) ? { viewOnly: true } : {}),
    })),
  );
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

const SAME_SHARE = `SELECT email, ${SHARE_ROLE_CASE} AS role, created_at AS createdAt FROM shares WHERE artifact_id = ? AND email = ? AND role = ? AND can_comment = ?`;
const OPTED_OUT = "select 1 as x from email_optouts where address_hash = ?1";
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
  s: { email: string; role?: ShareRole },
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<ShareResult> {
  const artifact = await ownerOnly(env, user, id);
  // Sharing is free on every payment plan and lock (a mechanism to make OA
  // viral). A suspension is an operator's stop, not a payment state: no new
  // shares under it, for anyone.
  if (suspendedMember(user)) requireTeamPlan(planOfMember(user));
  const email = normalizeEmail(s.email);
  if (!email) throw new ApiError("bad_request", "Invalid email");
  if (email === normalizeEmail(user.email))
    throw new ApiError("bad_request", "Cannot share with yourself");
  // No role given: a guest comments, anyone else views.
  const reach = await shareReach(env, email);
  const guest = await guestRecipients(env)(email, reach.role);
  // An outsider is never stored as editor: a guest comments at most.
  const asked = s.role ?? (guest ? "commenter" : "viewer");
  const role: ShareRole = guest && asked === "editor" ? "commenter" : asked;
  const stored = storedShare(role);
  // #2590: with the owner's switch off, no new share to an address outside
  // the instance (no user row here). A person already in stays shareable.
  if (
    outsideAddress(env, email) &&
    !(await stmt(env.DB, IS_USER).bind(email).first()) &&
    !(await outsideSharingOn(env))
  )
    throw new ApiError(
      "outside_sharing_off",
      "Sharing with people outside is off. An owner can turn it on in Settings, Sharing.",
    );
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
      `INSERT INTO shares (artifact_id, email, role, can_comment, created_by, created_at)
       SELECT ?1, ?2, ?3, ?7, ?4, ?5
       WHERE (SELECT count(*) FROM shares WHERE artifact_id = ?1) < ?6
          OR EXISTS (SELECT 1 FROM shares WHERE artifact_id = ?1 AND email = ?2)
       ON CONFLICT (artifact_id, email) DO UPDATE SET role = excluded.role, can_comment = excluded.can_comment
         WHERE shares.role <> excluded.role OR shares.can_comment <> excluded.can_comment
       RETURNING email, ${SHARE_ROLE_CASE} AS role, created_at AS createdAt`,
    ).bind(id, email, stored.role, user.id, now, MAX_SHARES, stored.canComment),
    shareAudit(env, "artifact.share", user, artifact, { role }),
  ]);
  // No row back: unchanged (already at this role) or refused at the cap.
  const row =
    res?.results[0] ??
    (await stmt(env.DB, SAME_SHARE)
      .bind(id, email, stored.role, stored.canComment)
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
  if (res?.results[0] && !created && role !== "editor")
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
  // #1292: a new direct share tells the recipient's picked agents, after
  // the response; ids and the link only.
  if (created) await inBackground(ctx, notifyShared(env, user.id, email, id));
  // #2512 S2: a member the page is shared with sees it in their inbox.
  if (created)
    await inBackground(
      ctx,
      recordShareItem(env, {
        artifactId: id,
        title: artifact.title,
        email,
        sharer: user.id,
        sharerName: senderName(user),
        createdAt: row.createdAt,
      }),
    );
  // Review item 37: whether they can sign in at all (an in-domain
  // non-member on an invite-only install can't); the share stands either way.
  return {
    ...toShare(row),
    ...(guest ? { guest: true } : {}),
    ...(await emailed(created, () =>
      emailShare(env, user, artifact, email, role, reach),
    )),
    ...(reach.recipient ? { recipient: reach.recipient } : {}),
    // The list the share email names (reach.ts), so the UI and email agree.
    signInMethods: reach.methods,
    // The ways in, [] when nothing admits them (#2590).
    reach: { ways: reach.ways },
  };
}

/** ShareResult's emailed and, when a limit refused it, notEmailed. */
async function emailed(
  created: boolean,
  send: () => Promise<{
    emailed: boolean;
    notEmailed?: NonNullable<ShareResult["notEmailed"]>;
    limit?: number;
  }>,
): Promise<Pick<ShareResult, "emailed" | "notEmailed" | "limit">> {
  if (!created) return { emailed: false };
  const r = await send();
  return {
    emailed: r.emailed,
    ...(r.notEmailed ? { notEmailed: r.notEmailed } : {}),
    ...(r.limit !== undefined ? { limit: r.limit } : {}),
  };
}

/** Outside shares emailed per member per UTC day (#2590). */
export const OUTSIDE_EMAILS_PER_MEMBER_PER_DAY = 20;
/**
 * Outside share emails per instance per UTC day, and during a trial (the
 * issue gives no numbers: 100 and 20).
 */
export const OUTSIDE_EMAILS_PER_INSTANCE_PER_DAY = 100;
export const OUTSIDE_EMAILS_PER_INSTANCE_PER_DAY_TRIAL = 20;

async function emailShare(
  env: Env,
  user: Member,
  artifact: { id: string; title: string; format: string; doc: number },
  email: string,
  role: ShareRole,
  /** The methods that admit the recipient and, with none, why (shareReach). */
  reach: { methods: SignInProvider[]; recipient?: ShareRecipient },
): Promise<{
  emailed: boolean;
  notEmailed?: NonNullable<ShareResult["notEmailed"]>;
  limit?: number;
}> {
  if (!emailEnabled(env)) return { emailed: false };
  try {
    const [member, settings] = await Promise.all([
      stmt(env.DB, IS_USER).bind(email).first(),
      getSettings(env),
    ]);
    if (member) return { emailed: false };
    // An outside address gets the outside email (plain template, a capped
    // title, no URL-like sender text) on every install. The daily limits are
    // hosted's: a self-hosted install sends it, without limits. Anyone else (a login domain's address) gets the normal share
    // email, with its role line, as on main.
    const outside = outsideAddress(env, email);
    // "Don't email me again": an address that opted out gets no outside share
    // email (#2590). Across hosted would be a call to the platform here.
    const optOutHash = outside ? await addressHash(email) : null;
    if (
      optOutHash &&
      (await stmt(env.DB, OPTED_OUT).bind(optOutHash).first())
    ) {
      // The sharer is not told a recipient opted out (that choice is the
      // recipient's): the result says "skipped"; the log has the reason.
      logInfo("share_email_skipped", {
        reason: "recipient_opted_out",
        artifactId: artifact.id,
      });
      return { emailed: false, notEmailed: "skipped" };
    }
    const optOutUrl = outside
      ? optoutUrl(env.APP_HOST, await signOptoutToken(env, email))
      : "";
    const hosted = env.HOSTED === "1";
    // No user row. An outside address (#2590) gets the outside email, under
    // its own daily limits (apart from the usual ones; the share is saved
    // whatever they say). Anyone else (an address at a login domain, an
    // Access install) gets the normal share email, with its role line.
    const day = new Date().toISOString().slice(0, 10);
    const trial = planOfMember(user)?.tier === "trial";
    const outcome: { limited?: boolean; reason?: string } = {};
    const sent = await sendEmail(
      env,
      user.id,
      email,
      () =>
        outside
          ? outsideShareEmail({
              inviter: senderName(user),
              senderEmail: normalizeEmail(user.email) ?? user.email,
              instance: settings.name,
              recipient: email,
              appHost: env.APP_HOST,
              title: artifact.title,
              path: viewerPath(artifact.id),
              signIn: reach.methods,
              cantSignIn: reach.recipient?.reason,
              optOutUrl,
            })
          : shareEmail({
              inviter: senderName(user),
              instance: settings.name,
              recipient: email,
              appHost: env.APP_HOST,
              title: artifact.title,
              path: viewerPath(artifact.id),
              format: apiFormat(artifact.format, artifact.doc),
              role,
              signIn: reach.methods,
              cantSignIn: reach.recipient?.reason,
            }),
      {
        kind: "share",
        artifactId: artifact.id,
        instance: settings.name,
        replyTo: normalizeEmail(user.email) ?? undefined,
        outcome,
        extraCaps: !(outside && hosted)
          ? []
          : [
              {
                cap: [
                  `email:out:u:${user.id}`,
                  OUTSIDE_EMAILS_PER_MEMBER_PER_DAY,
                  day,
                ],
                reason: "member_limit",
              },
              {
                cap: [
                  "email:out:*",
                  trial
                    ? OUTSIDE_EMAILS_PER_INSTANCE_PER_DAY_TRIAL
                    : OUTSIDE_EMAILS_PER_INSTANCE_PER_DAY,
                  day,
                ],
                reason: "instance_limit",
              },
            ],
      },
    );
    if (sent) return { emailed: true };
    if (!outcome.limited) return { emailed: false };
    // The number a member_limit or instance_limit refusal hit, for the page.
    if (outcome.reason === "member_limit")
      return {
        emailed: false,
        notEmailed: "member_limit",
        limit: OUTSIDE_EMAILS_PER_MEMBER_PER_DAY,
      };
    if (outcome.reason === "instance_limit")
      return {
        emailed: false,
        notEmailed: "instance_limit",
        limit: trial
          ? OUTSIDE_EMAILS_PER_INSTANCE_PER_DAY_TRIAL
          : OUTSIDE_EMAILS_PER_INSTANCE_PER_DAY,
      };
    return { emailed: false, notEmailed: "limit" };
  } catch {
    return { emailed: false };
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
  "email = ?1 AND role = 'guest' AND invited_at IS NULL AND NOT EXISTS (SELECT 1 FROM shares WHERE email = ?1) AND NOT EXISTS (SELECT 1 FROM space_members sm WHERE sm.user_id = users.id)";
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
