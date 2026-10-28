import { withBrokerProps } from "./auth/broker-transport.js";
import { sweepLoginCodes } from "./auth/codes.js";
import { stmt } from "./db/stmt.js";
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
 * nothing).
 * Self-host (O1): Workers Free allows 5 cron triggers per account, so an
 * install has one, RECOVERY_CRON (every 2 min): each tick runs the lost
 * index and thumbnail sweep, and the tick in the daily slot (03:18 UTC) runs
 * the daily work once. An install still on DAILY_CRON alone keeps running
 * the daily work from it; one with both runs it once a day (claimDaily).
 * Any other non-`oa:` cron runs the daily work, as before. */
export function scheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  // The scheduler's broker capabilities (ctx.props) for this invocation.
  return withBrokerProps(ctx, () => run(event, env, ctx));
}

/** The controller's cron, and its scheduledTime when the caller passes one. */
type ScheduledEvent = Pick<ScheduledController, "cron"> &
  Partial<Pick<ScheduledController, "scheduledTime">>;

async function run(
  event: ScheduledEvent,
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
  if (event.cron === RECOVERY_CRON) {
    const at = event.scheduledTime ?? Date.now();
    // Every tick: the bounded, windowed lost index and thumbnail sweep (two
    // indexed reads when there is nothing to recover).
    ctx.waitUntil(
      sweepLostIndexJobs(env, at, "tick").catch((e) =>
        logError("cron_task_failed", e),
      ),
    );
    if (!inDailySlot(at) || !(await claimDaily(env, at))) return;
    daily(env, ctx, Date.now(), false);
    return;
  }
  daily(env, ctx, Date.now(), env.HOSTED !== "1");
}

/** Self-host's one cron trigger (O1): every 2 minutes. */
export const RECOVERY_CRON = "*/2 * * * *";
/** The daily trigger: self-host before O1, and the hosted scheduler's nightly call. */
export const DAILY_CRON = "17 3 * * *";
const TICK_MS = 2 * 60_000;
const DAY_MS = 86_400_000;
/**
 * The RECOVERY_CRON tick that runs the daily work: the first tick at or
 * after DAILY_CRON's time (03:17 UTC, so the 03:18 tick), one TICK_MS wide.
 * After it, not before, so an install still carrying the DAILY_CRON trigger
 * as well has already marked the day (see claimDaily) and the tick skips it.
 */
export const DAILY_SLOT_START_MS = (() => {
  const [min, hour] = DAILY_CRON.split(" ").map(Number) as [number, number];
  return Math.ceil(((hour * 60 + min) * 60_000) / TICK_MS) * TICK_MS;
})();
export const inDailySlot = (t: number): boolean => {
  const d = ((t % DAY_MS) + DAY_MS) % DAY_MS;
  return d >= DAILY_SLOT_START_MS && d < DAILY_SLOT_START_MS + TICK_MS;
};

/** settings row: the UTC day (YYYY-MM-DD) the daily work last ran. */
export const DAILY_RAN_KEY = "cron_daily_ran";
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const MARK_DAY = `insert into settings (key, value) values (?1, ?2)
  on conflict (key) do update set value = excluded.value`;
const CLAIM_DAY = `insert into settings (key, value) values (?1, ?2)
  on conflict (key) do update set value = excluded.value
  where settings.value <> excluded.value`;

/**
 * The daily slot tick claims its UTC day: false when the daily work already
 * ran that day (a DAILY_CRON trigger at 03:17, or a repeated tick). A D1
 * error claims it anyway: the daily jobs are idempotent and bounded, so a
 * second run is cheaper than a lost day.
 */
async function claimDaily(env: Env, at: number): Promise<boolean> {
  try {
    const r = await stmt(env.DB, CLAIM_DAY)
      .bind(DAILY_RAN_KEY, utcDay(at))
      .run();
    return (r.meta.changes ?? 0) > 0;
  } catch (e) {
    logWarn("cron_daily_claim", e);
    return true;
  }
}

function daily(
  env: Env,
  ctx: ExecutionContext,
  now: number,
  mark: boolean,
): void {
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
      // DAILY_CRON on self-host marks the day, so the slot tick of an install
      // that has both triggers doesn't run it again. Hosted gets no
      // RECOVERY_CRON (no per-install triggers): nothing to mark.
      mark
        ? stmt(env.DB, MARK_DAY).bind(DAILY_RAN_KEY, utcDay(now)).run()
        : null,
    ]).then((rs) => {
      for (const r of rs)
        if (r.status === "rejected") logError("cron_task_failed", r.reason);
      return rs;
    }),
  );
}
