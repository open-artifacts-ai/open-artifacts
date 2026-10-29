import { withBrokerProps } from "./auth/broker-transport.js";
import { sweepLoginCodes } from "./auth/codes.js";
import { usageTick } from "./billing/creators.js";
import { billingTick } from "./billing/store.js";
import { disconnectDirectory } from "./directory/connect.js";
import { expirePending } from "./directory/store.js";
import { sweepEmailCounters } from "./email/send.js";
import type { Env } from "./env.js";
import { logError, logInfo, logWarn } from "./log.js";
import { sweepUngrantedClients } from "./mcp/registrations.js";
import {
  purgeDeleted,
  reindexStale,
  sweepLostIndexJobs,
} from "./services/artifacts.js";
import { sweepAuditEvents } from "./services/audit.js";
import { feedSync, kickSync } from "./services/directory.js";
import { checkLatestRelease } from "./services/release.js";
import { directoryMode } from "./services/spaces.js";
import { sweepUploads } from "./services/uploads.js";

/**
 * Platform system jobs (hosted). The platform calls an install's
 * scheduled() through its dispatch namespace binding with one of these as
 * `cron`. No HTTP route reaches them and no user credential is involved:
 * only a holder of a binding to this script can call scheduled(), and
 * Cloudflare's own cron triggers pass a cron expression (a hosted upload has
 * none; a self-hosted install has CRON), never an `oa:` name.
 */
export const SYSTEM_JOB_PREFIX = "oa:";
/**
 * Before a hosted install is deleted: the directory disconnect (revoke the
 * Google grant while this install still holds its keys, wipe, stop sync),
 * actor system. Idempotent; the mismatch tombstone rule applies. Resolves
 * when Google confirmed the revoke (or the grant was already invalid) and
 * the state is wiped, or when nothing is connected. Rejects, keeping every
 * key, when a revoke failed (transport error, 5xx, 429; audited
 * revoke_failed), when a consent landed after its reads (audited
 * late_consent_kept), or when it could not run (a D1 error), so the
 * platform retries.
 * Order: run it before the install leaves DIRECTORY_REGISTRY. The broker
 * answers an unknown install 401 for good, and the job then never resolves.
 * Rejects on every retry (permanent, needs an operator): no transport
 * configured, a token this install cannot decrypt, an install unknown to
 * the broker.
 */
export const DIRECTORY_DISCONNECT_CRON = "oa:directory-disconnect";

/**
 * Every 2 min (hosted): DirectorySync's alarm can't reach the directory
 * broker, so this tick asks it whether a run is due (its own stored timing)
 * and, if so, mints the access token through this invocation's
 * DIRECTORY_BROKER capability and hands over the token (services/directory.ts
 * feedSync). Resolves with nothing to do on a self-hosted install. Rejects
 * on a D1 or DO error.
 * The same tick also runs the bounded, windowed sweep for index and
 * thumbnail jobs a publish lost (sweepLostIndexJobs "tick"), in waitUntil
 * and registered first, so a feedSync rejection never skips it.
 */
export const DIRECTORY_SYNC_CRON = "oa:directory-sync";

/** Daily cron: purge soft-deleted artifacts past 30 days, sweep stale uploads,
 * delete OAuth clients that never completed a grant, re-enqueue search
 * indexing or a thumbnail job that never landed (C3), drop past days' email counters and
 * expired sign-in codes, check the latest release (B3; never on HOSTED=1), and drop a directory
 * connection left unconfirmed past 24 h (P3 T12), kick DirectorySync
 * (P3 T13), and delete audit rows past AUDIT_RETENTION_MS (400 days), a
 * bounded batch per run (sweepAuditEvents). An `oa:` cron is a platform
 * system job instead (above); an unknown one is refused (rejects, runs
 * nothing). */
export function scheduled(
  event: Pick<ScheduledController, "cron">,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  // The scheduler's broker capabilities (ctx.props) for this invocation.
  return withBrokerProps(ctx, () => run(event, env, ctx));
}

async function run(
  event: Pick<ScheduledController, "cron">,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  if (event.cron?.startsWith(SYSTEM_JOB_PREFIX)) {
    if (event.cron === DIRECTORY_SYNC_CRON) {
      ctx.waitUntil(
        sweepLostIndexJobs(env, Date.now(), "tick").catch((e) =>
          logError("cron_task_failed", e),
        ),
      );
      // Hosted billing: read the tier through this tick's BILLING gate (and
      // retry a trial start an invite couldn't make), then the monthly
      // creator report. Both never throw; nothing on a self-hosted install.
      ctx.waitUntil(
        (async () => {
          const now = Date.now();
          await billingTick(env, now);
          await usageTick(env, now);
        })().catch((e) => logError("cron_task_failed", e)),
      );
      const fed = await feedSync(env);
      if (fed === "fed" || fed === "mint_failed")
        logInfo("system_job", { job: "directory-sync", state: fed });
      return;
    }
    if (event.cron !== DIRECTORY_DISCONNECT_CRON) {
      logWarn("system_job_unknown", new Error("unknown system job"));
      throw new Error("unknown system job");
    }
    const s = await disconnectDirectory(
      env,
      { kind: "system", id: null },
      { showProblem: false, retry: true },
    );
    logInfo("system_job", { job: "directory-disconnect", state: s.state });
    return;
  }
  const now = Date.now();
  ctx.waitUntil(
    Promise.allSettled([
      purgeDeleted(env, now),
      sweepUploads(env, now),
      sweepUngrantedClients(env, now),
      reindexStale(env, now),
      sweepEmailCounters(env, now),
      sweepLoginCodes(env, now),
      // Hosted: the platform upgrades tenants; no GitHub call (review item 39).
      env.HOSTED === "1" ? null : checkLatestRelease(env, now),
      expirePending(env, now, { cron: true }),
      sweepAuditEvents(env, now),
      // DirectorySync keeps its own 2 min alarm; the daily kick restarts a
      // lost one.
      directoryMode(env) === "off" ? null : kickSync(env, "cron"),
    ]).then((rs) => {
      for (const r of rs)
        if (r.status === "rejected") logError("cron_task_failed", r.reason);
      return rs;
    }),
  );
}
