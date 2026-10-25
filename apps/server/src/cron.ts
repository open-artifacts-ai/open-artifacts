import { sweepLoginCodes } from "./auth/codes.js";
import { disconnectDirectory } from "./directory/connect.js";
import { expirePending } from "./directory/store.js";
import { sweepEmailCounters } from "./email/send.js";
import type { Env } from "./env.js";
import { logError, logInfo, logWarn } from "./log.js";
import { sweepUngrantedClients } from "./mcp/registrations.js";
import { purgeDeleted, reindexStale } from "./services/artifacts.js";
import { sweepAuditEvents } from "./services/audit.js";
import { kickSync } from "./services/directory.js";
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
 * actor system. Idempotent; the mismatch tombstone rule applies. Rejects
 * when it could not run (a D1 error), so the platform can retry.
 */
export const DIRECTORY_DISCONNECT_CRON = "oa:directory-disconnect";

/** Daily cron: purge soft-deleted artifacts past 30 days, sweep stale uploads,
 * delete OAuth clients that never completed a grant, re-enqueue search
 * indexing that never completed (C3), drop past days' email counters and
 * expired sign-in codes, check the latest release (B3), and drop a directory
 * connection left unconfirmed past 24 h (P3 T12), kick DirectorySync
 * (P3 T13), and delete audit rows past AUDIT_RETENTION_MS (400 days), a
 * bounded batch per run (sweepAuditEvents). An `oa:` cron is a platform
 * system job instead (above); an unknown one is refused (rejects, runs
 * nothing). */
export async function scheduled(
  event: Pick<ScheduledController, "cron">,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  if (event.cron?.startsWith(SYSTEM_JOB_PREFIX)) {
    if (event.cron !== DIRECTORY_DISCONNECT_CRON) {
      logWarn("system_job_unknown", new Error("unknown system job"));
      throw new Error("unknown system job");
    }
    const s = await disconnectDirectory(
      env,
      { kind: "system", id: null },
      { showProblem: false },
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
      checkLatestRelease(env, now),
      expirePending(env, now),
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
