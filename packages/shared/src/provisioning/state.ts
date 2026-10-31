// platform_state keys and the scheduler's intervals (design v7 3.6, 4.7, 4.9,
// 5.8; 0006_platform_state.sql). Plain constants, no zod: the scheduler, W8
// (the monitor's dead-man) and R27 import `@oa/shared/provisioning/state`.
import { ALERT_KEYS, type AlertKey } from "./enum-values.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** The keys 0006's comment lists, verbatim (`<alert>` is an ALERT_KEYS key). */
export const PLATFORM_STATE_0006_KEYS = [
  "scheduler_tick_at",
  "<alert>_opened_at",
  "<alert>_notified_at",
  "<alert>_cleared_at",
] as const;

/** The scheduler's last two-minute tick (5.8 dead-man). In 0006. */
export const SCHEDULER_TICK_KEY = "scheduler_tick_at";
/**
 * The dead-man threshold: a `scheduler_tick_at` older than this is stale
 * (5.8; the monitor fails with `scheduler_stale`, 6.2).
 */
export const SCHEDULER_STALE_MS = 10 * MIN;

/**
 * Alert state suffixes: `opened_at`, `notified_at`, `cleared_at` are in 0006;
 * `sending_at` (an open or reminder email in flight, W7) is not.
 */
export const ALERT_STATE_SUFFIXES = [
  "opened_at",
  "notified_at",
  "cleared_at",
  "sending_at",
] as const;
export type AlertStateSuffix = (typeof ALERT_STATE_SUFFIXES)[number];

/** `<alert>_<suffix>`, the platform_state key of one alert's state. */
export function alertStateKey(key: AlertKey, suffix: AlertStateSuffix): string {
  if (!(ALERT_KEYS as readonly string[]).includes(key))
    throw new Error(`unknown alert key ${String(key)}`);
  if (!(ALERT_STATE_SUFFIXES as readonly string[]).includes(suffix))
    throw new Error(`unknown alert state suffix ${String(suffix)}`);
  return `${key}_${suffix}`;
}

/**
 * The hourly health gate on the two-minute tick (2.4, 5.8: "behind a
 * platform_state timestamp gate"); the design names no key. Not in 0006.
 */
export const HEALTH_GATE_KEY = "health_checked_at";
/** The health round in progress (W7). Not in 0006. */
export const HEALTH_ROUND_KEY = "health_round_at";
/** /healthz once an hour per mapped install (5.8 "hourly gate"). */
export const HEALTH_INTERVAL_MS = 60 * MIN;

/** The last jobs rowid the sweep's open-jobs page reached (W7). Not in 0006. */
export const SWEEP_CURSOR_KEY = "sweep_open_cursor";
/** `sweep_terminated:<jobId>`: when the sweep first saw the run terminated (W7). Not in 0006. */
export const SWEEP_TERMINATED_PREFIX = "sweep_terminated:";
export function sweepTerminatedKey(jobId: string): string {
  if (typeof jobId !== "string" || !ULID.test(jobId))
    throw new Error("sweepTerminatedKey needs a job id (ULID)");
  return `${SWEEP_TERMINATED_PREFIX}${jobId}`;
}

/**
 * A `queued` job with no start this long after `created_at` is started by
 * the sweep (5.8 "no start after 60 s", 3.6). The marker is
 * `jobs.started_at` (8.3), written when the run starts.
 */
export const JOB_START_GRACE_MS = 60_000;
/** A self-serve signup pending this long is re-enqueued (5.8, #859 sweepStale). */
export const SELF_SERVE_STALE_MS = 15 * MIN;

/** Nightly prune (5.8): `audit_refusals` older than 90 days (4.9). */
export const AUDIT_REFUSAL_RETENTION_MS = 90 * DAY;
/** Nightly prune: `rate_counters` windows older than 2 h (4.7 hourly counters). */
export const RATE_COUNTER_RETENTION_MS = 2 * 60 * MIN;
/** Nightly prune: the DCR UTC-day `rate_counters` windows after 48 h. */
export const DCR_COUNTER_RETENTION_MS = 48 * 60 * MIN;
/** Nightly prune: `sessions` and `agent_tokens` (both kinds) expired over 7 days. */
export const EXPIRED_AUTH_RETENTION_MS = 7 * DAY;
