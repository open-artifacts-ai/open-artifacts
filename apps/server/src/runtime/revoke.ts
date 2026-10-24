import { planOf } from "@oa/shared";
import { logAuth } from "../auth/audit.js";
import type { Env } from "../env.js";
import { logError } from "../log.js";
import { type GoneReason, runtimeStub } from "./do.js";
import { presenceStub } from "./presence.js";

type Ctx = Pick<ExecutionContext, "waitUntil">;

/** At most this many artifact DOs are signalled per call (best effort). */
export const MAX_CLOSE = 50;

/**
 * Closes the live-data sockets (4403) of each artifact's runtime DO after an
 * access change (share revoked, visibility changed, deleted, member removed).
 * Subscribers reconnect through the shell, which re-checks access. Runs in
 * waitUntil when a context is given; never throws. `gone` is the R.events
 * frame's reason: "deleted" for a soft delete, "changed" otherwise.
 */
export async function closeRuntimeSockets(
  env: Pick<Env, "ARTIFACT_RUNTIME">,
  ids: readonly string[],
  reason: string,
  ctx?: Ctx,
  gone: GoneReason = "changed",
): Promise<void> {
  const all = Promise.allSettled(
    [...new Set(ids)]
      .slice(0, MAX_CLOSE)
      .map((id) => runtimeStub(env, id).closeSockets(reason, gone)),
  ).then((rs) => {
    for (const r of rs)
      if (r.status === "rejected") logError("close_sockets_failed", r.reason);
  });
  if (ctx) ctx.waitUntil(all);
  else await all;
}

/** Retries of a failed UserPresence.closeAll call inside revokeUserLive. */
export const REVOKE_RETRIES = 3;
/** Delay before the n-th retry (1-based): 50, 100, 200 ms. */
export const revokeRetryMs = (n: number) => 50 * 2 ** (n - 1);

/**
 * Closes every live socket `userId` holds (data and events, 4403) after
 * their access was cut: status change, membership or mapping narrowing,
 * sync, member removal, transfer, customer mismatch. UserPresence sets
 * revokedAt first, so a socket racing the revocation is refused too; failed
 * closes are retried by its alarm. A failed closeAll call is retried up to
 * REVOKE_RETRIES times (revokeRetryMs apart), each on a fresh stub; if it
 * still fails, an alert-level `presence_revoke_failed` is logged and
 * revokedAt alone is written (markRevoked), so new accepts are refused while
 * open sockets wait for their TTL. Without the USER_PRESENCE binding every
 * call logs presence_unbound. Runs in waitUntil when a context is given.
 * Never throws.
 */
export async function revokeUserLive(
  env: Pick<Env, "USER_PRESENCE">,
  userId: string,
  reason: string,
  ctx?: Ctx,
): Promise<void> {
  const run = (async () => {
    if (!env.USER_PRESENCE) {
      logError("presence_unbound", new Error("USER_PRESENCE is not bound"));
      return;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await presenceStub(env, userId)?.closeAll(reason);
        return;
      } catch (e) {
        if (attempt >= REVOKE_RETRIES) {
          logError("revoke_user_live_failed", e);
          break;
        }
        logError("revoke_user_live_retry", e, { attempt: attempt + 1 });
        await new Promise((r) => setTimeout(r, revokeRetryMs(attempt + 1)));
      }
    }
    logAuth({ evt: "presence_revoke_failed", uid: userId });
    await presenceStub(env, userId)?.markRevoked();
  })().catch((e) => logError("revoke_user_live_failed", e));
  if (ctx) {
    try {
      ctx.waitUntil(run);
      return;
    } catch (e) {
      logError("revoke_user_live_failed", e);
    }
  }
  await run;
}

/** Users revoked concurrently per page by revokeUsersLive. */
export const REVOKE_PAGE = 50;

/**
 * Most users one revokeUsersLive call revokes, per plan. Each user is one
 * UserPresence call (more on a retry: up to REVOKE_RETRIES more plus
 * markRevoked), and every call counts toward the invocation's subrequest
 * limit (Workers Free 50, Paid 1000 by default), alongside the request's own
 * D1 and DO calls. The cap keeps half the limit, after a reserve for the
 * request, for retries: Free (50 - 10) / 2 = 20, Paid (1000 - 100) / 2 = 450.
 */
export const REVOKE_FANOUT_CAP = { free: 20, paid: 450 } as const;

export const revokeFanoutCap = (env: Pick<Env, "PLAN">): number =>
  REVOKE_FANOUT_CAP[planOf(env.PLAN)];

/**
 * revokeUserLive for many users after a space-wide narrowing (a mapping
 * removed or lowered, allMembersRole lowered, a restricted group added):
 * pages of REVOKE_PAGE concurrent calls, one page after another, up to
 * revokeFanoutCap(env) users. Past the cap, an alert-level
 * `revoke_fanout_truncated` is logged and the rest are not signalled: the D1
 * change already refuses their next request and reconnect, and their open
 * sockets end at the socket TTL (10 minutes) until P3 T13's DirectorySync
 * queue takes the fan-out. Runs in waitUntil when a context is given, so
 * the response never waits on it. Never throws.
 */
export async function revokeUsersLive(
  env: Pick<Env, "USER_PRESENCE" | "PLAN">,
  userIds: readonly string[],
  reason: string,
  ctx?: Ctx,
): Promise<void> {
  const all = [...new Set(userIds)];
  if (!all.length) return;
  const cap = revokeFanoutCap(env);
  if (all.length > cap)
    logAuth({ evt: "revoke_fanout_truncated", total: all.length, cap });
  const ids = all.slice(0, cap);
  const run = (async () => {
    for (let i = 0; i < ids.length; i += REVOKE_PAGE)
      await Promise.all(
        ids
          .slice(i, i + REVOKE_PAGE)
          .map((id) => revokeUserLive(env, id, reason)),
      );
  })().catch((e) => logError("revoke_users_live_failed", e));
  if (ctx) {
    try {
      ctx.waitUntil(run);
      return;
    } catch (e) {
      logError("revoke_users_live_failed", e);
    }
  }
  await run;
}
