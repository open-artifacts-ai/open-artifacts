import { sweepLoginCodes } from "./auth/codes.js";
import { expirePending } from "./directory/store.js";
import { sweepEmailCounters } from "./email/send.js";
import type { Env } from "./env.js";
import { logError } from "./log.js";
import { sweepUngrantedClients } from "./mcp/registrations.js";
import { purgeDeleted, reindexStale } from "./services/artifacts.js";
import { kickSync } from "./services/directory.js";
import { checkLatestRelease } from "./services/release.js";
import { directoryMode } from "./services/spaces.js";
import { sweepUploads } from "./services/uploads.js";

/** Daily cron: purge soft-deleted artifacts past 30 days, sweep stale uploads,
 * delete OAuth clients that never completed a grant, re-enqueue search
 * indexing that never completed (C3), drop past days' email counters and
 * expired sign-in codes, check the latest release (B3), and drop a directory
 * connection left unconfirmed past 24 h (P3 T12), and kick DirectorySync
 * (P3 T13). */
export async function scheduled(
  _event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
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
