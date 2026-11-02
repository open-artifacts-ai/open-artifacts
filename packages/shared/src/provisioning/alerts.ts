/**
 * Provisioning API operator alerts (design v7 5.8, 9A.5 R27). The scheduler
 * is the only alert opener; it runs these queries on platform D1 on every
 * two-minute tick, and R27 `GET /world` runs the same ones for `attention`, so there is
 * one copy of the rules. Open state lives in `platform_state`
 * (`<key>_opened_at`, 0006).
 *
 * Every query is read-only and returns rows of one shape (`AlertRow`): no
 * row means the condition does not hold. Times are epoch milliseconds; a
 * query that takes `now` binds it as `?1` (`alertParams`). `token_expiring` and `token_invalid` come from
 * `PROVISIONER.tokenStatus()`, not D1, so they have no query. The key list
 * is `ALERT_KEYS` (enum-values.ts).
 */

import { ALERT_KEYS, type AlertKey } from "./enum-values.js";

/** Keys read from `PROVISIONER.tokenStatus()` rather than D1. */
export const RPC_ALERT_KEYS = [
  "token_expiring",
  "token_invalid",
] as const satisfies readonly AlertKey[];
export type SqlAlertKey = Exclude<AlertKey, (typeof RPC_ALERT_KEYS)[number]>;
export const SQL_ALERT_KEYS = ALERT_KEYS.filter(
  (k): k is SqlAlertKey => !(RPC_ALERT_KEYS as readonly string[]).includes(k),
);

/** Refused sign-ins over this window open `signin_refused_burst` (4.8). */
export const SIGNIN_BURST_WINDOW_MS = 10 * 60_000;
export const SIGNIN_BURST_MIN = 5;
/**
 * The `audit_refusals` buckets (4.9): `refuse(env, bucket, code, req)` takes
 * one of these, so the alert queries and R17 see every refusal.
 * - `pre`: `RL_PV_PRE_IP` 429s.
 * - `auth`: `auth.refused`.
 * - `csrf`: `csrf.refused`.
 * - `signin`: `signin.bad_flow` and the `RL_PV_SIGNIN_IP` 429s.
 * - `slug`: `RL_PV_SLUG_IP` 429s.
 * - `oauth`: `RL_PV_OAUTH_IP` 429s on `/oauth/token` and consent.
 * - `oauth_register`: refused `/oauth/register` calls, its 429s included.
 */
export const AUDIT_REFUSAL_BUCKETS = [
  "pre",
  "auth",
  "csrf",
  "signin",
  "slug",
  "oauth",
  "oauth_register",
] as const;
export type AuditRefusalBucket = (typeof AUDIT_REFUSAL_BUCKETS)[number];
/** The bucket `signin_refused_burst` sums. */
export const SIGNIN_REFUSAL_BUCKET = "signin" satisfies AuditRefusalBucket;
/** `audit_refusals` rows aggregate refusals per window of this length (4.9). */
export const AUDIT_REFUSAL_WINDOW_MS = 10 * 60_000;
/** How long an `unknown_sub` refusal and a failed job stay in attention. */
export const ALERT_LOOKBACK_MS = 24 * 60 * 60_000;
/**
 * `job_retrying` from the 3rd attempt on. `jobs.attempt` counts failed
 * attempts (the step wrapper writes it in its catch, 3.6), so the 3rd
 * attempt is running once it reaches 2.
 */
export const JOB_RETRYING_ATTEMPT = 2;
/** An open job unchanged this long, with no future retry, is stuck. */
export const JOB_STUCK_MS = 2 * 60 * 60_000;
/** Failed purge jobs before `purge_stuck` (the scheduler's cap). */
export const PURGE_STUCK_FAILURES = 3;
/** A welcome claim older than this that never sent. */
export const WELCOME_CLAIM_MS = 15 * 60_000;
/** MCP client registrations in a UTC day over this open `oauth_register_flood`. */
export const OAUTH_REGISTER_FLOOD = 500;

const DAY_MS = 24 * 60 * 60_000;
// The start of now's UTC day.
const TODAY = `(?1 - ?1 % ${DAY_MS})`;

/** One row of an alert-condition query. */
export interface AlertRow {
  install_id: string | null;
  job_id: string | null;
  job_kind: string | null;
  code: string | null;
  message: string | null;
  since: number;
}

export interface AlertInput {
  now: number;
  /** The scheduler's `SIGNUP_DAILY_CAP`. */
  signupDailyCap: number;
}

export interface AlertCondition {
  sql: string;
  /** What `?1`, `?2`, ... bind, in order. */
  params: readonly (keyof AlertInput)[];
}

const NOW: AlertCondition["params"] = ["now"];
const NONE: AlertCondition["params"] = [];

// A failed job's row; message is cut to AttentionSchema's 200.
const FAILED_JOB = `j.install_id AS install_id, j.id AS job_id, j.kind AS job_kind, j.error_code AS code, substr(j.error_message, 1, 200) AS message, COALESCE(j.finished_at, j.updated_at) AS since`;
const OPEN_JOB = `j.install_id AS install_id, j.id AS job_id, j.kind AS job_kind, j.last_error_code AS code, substr(j.error_message, 1, 200) AS message, j.updated_at AS since`;
const STUCK = `j.updated_at <= ?1 - ${JOB_STUCK_MS} AND (j.retry_at IS NULL OR j.retry_at <= ?1)`;
// A later job of these kinds on the install finished the job's trouble.
const FIXED_BY = (kinds: string) =>
  `NOT EXISTS (SELECT 1 FROM jobs f WHERE f.install_id = j.install_id AND f.status = 'done' AND f.created_at >= j.created_at AND f.id <> j.id AND f.kind IN (${kinds}))`;
// Kinds that act on the install's state. Never cleanup, release_lease,
// redline_creds or update: the sweep and cancel insert a cleanup for every
// failure, so counting one would clear the failure it cleans up.
const STATE_KINDS = `'create', 'retry', 'upgrade', 'rollback', 'suspend', 'resume', 'delete', 'restore', 'purge', 'discard'`;

export const ALERT_CONDITIONS: Record<SqlAlertKey, AlertCondition> = {
  signin_refused_burst: {
    sql: `SELECT NULL AS install_id, NULL AS job_id, NULL AS job_kind, NULL AS code, NULL AS message, since FROM (
  -- An aggregate window that overlaps the window's start counts whole.
  SELECT MIN(since) AS since, SUM(n) AS total FROM (
    SELECT at AS since, 1 AS n FROM admin_audit WHERE action = 'signin.refused' AND at > ?1 - ${SIGNIN_BURST_WINDOW_MS}
    UNION ALL
    SELECT window_start AS since, count AS n FROM audit_refusals WHERE bucket = '${SIGNIN_REFUSAL_BUCKET}' AND window_start > ?1 - ${SIGNIN_BURST_WINDOW_MS + AUDIT_REFUSAL_WINDOW_MS}
  )
) WHERE total >= ${SIGNIN_BURST_MIN}`,
    params: NOW,
  },
  admin_unknown_sub: {
    sql: `SELECT NULL AS install_id, NULL AS job_id, NULL AS job_kind, 'unknown_sub' AS code, NULL AS message, since FROM (
  SELECT MIN(at) AS since FROM admin_audit WHERE action = 'signin.refused' AND code = 'unknown_sub' AND at > ?1 - ${ALERT_LOOKBACK_MS}
) WHERE since IS NOT NULL`,
    params: NOW,
  },
  job_failed: {
    // An admin cancel (code canceled) alerts too: the job did not finish.
    sql: `SELECT ${FAILED_JOB} FROM jobs j
WHERE j.status = 'failed' AND COALESCE(j.finished_at, j.updated_at) > ?1 - ${ALERT_LOOKBACK_MS}
  AND COALESCE(j.error_code, '') NOT IN ('prod_dirty', 'upgrade_incomplete')
  AND ${FIXED_BY(STATE_KINDS)}
  AND NOT (j.kind = 'purge' AND (SELECT COUNT(*) FROM jobs p WHERE p.install_id = j.install_id AND p.kind = 'purge' AND p.status = 'failed') >= ${PURGE_STUCK_FAILURES})
ORDER BY since, j.id`,
    params: NOW,
  },
  job_retrying: {
    sql: `SELECT ${OPEN_JOB} FROM jobs j
WHERE j.status IN ('queued', 'running') AND j.attempt >= ${JOB_RETRYING_ATTEMPT} AND NOT (${STUCK})
ORDER BY j.updated_at, j.id`,
    params: NOW,
  },
  job_stuck: {
    sql: `SELECT ${OPEN_JOB} FROM jobs j
WHERE j.status IN ('queued', 'running') AND ${STUCK}
ORDER BY j.updated_at, j.id`,
    params: NOW,
  },
  prod_dirty: {
    sql: `SELECT ${FAILED_JOB} FROM jobs j
WHERE j.status = 'failed' AND j.error_code = 'prod_dirty'
  AND ${FIXED_BY("'purge', 'discard'")}
ORDER BY since, j.id`,
    params: NONE,
  },
  prodclean_failed: {
    // The latest report only; never its install id or detail.
    sql: `SELECT NULL AS install_id, NULL AS job_id, NULL AS job_kind, r.code AS code, NULL AS message, r.at AS since FROM prodclean_reports r
WHERE r.id = (SELECT MAX(id) FROM prodclean_reports) AND r.ok = 0`,
    params: NONE,
  },
  upgrade_incomplete: {
    sql: `SELECT ${FAILED_JOB} FROM jobs j
WHERE j.status = 'failed' AND j.error_code = 'upgrade_incomplete'
  AND ${FIXED_BY("'upgrade', 'rollback', 'purge', 'discard'")}
ORDER BY since, j.id`,
    params: NONE,
  },
  unreachable_after_route: {
    // Health failing and the install's latest job is the done create or
    // retry that routed it; later failures are R27's health_failing.
    sql: `SELECT l.install_id AS install_id, j.id AS job_id, j.kind AS job_kind, 'health_failing' AS code, NULL AS message, COALESCE(l.health_at, j.finished_at, j.updated_at) AS since
FROM install_lifecycle l
JOIN jobs j ON j.id = (SELECT id FROM jobs WHERE install_id = l.install_id ORDER BY created_at DESC, id DESC LIMIT 1)
WHERE l.health = 'failing' AND l.deleted_at IS NULL AND l.discarded_at IS NULL
  AND j.kind IN ('create', 'retry') AND j.status = 'done'
ORDER BY since, l.install_id`,
    params: NONE,
  },
  purge_stuck: {
    // code is the latest failed purge's (SQLite takes bare columns from the
    // MAX row).
    sql: `SELECT j.install_id AS install_id, NULL AS job_id, 'purge' AS job_kind, j.error_code AS code, NULL AS message, MAX(COALESCE(j.finished_at, j.updated_at)) AS since
FROM jobs j WHERE j.kind = 'purge' AND j.status = 'failed'
GROUP BY j.install_id
HAVING COUNT(*) >= ${PURGE_STUCK_FAILURES}
  AND NOT EXISTS (SELECT 1 FROM jobs o WHERE o.install_id = j.install_id AND o.kind = 'purge' AND o.status IN ('queued', 'running', 'done'))
ORDER BY since, j.install_id`,
    params: NONE,
  },
  welcome_unsent: {
    sql: `SELECT s.install_id AS install_id, s.job_id AS job_id, (SELECT kind FROM jobs WHERE id = s.job_id) AS job_kind, NULL AS code, NULL AS message, COALESCE(s.welcome_claimed_at, s.updated_at) AS since
FROM signups s
WHERE s.send_welcome = 1 AND s.welcome_sent_at IS NULL
  AND (s.status = 'ready' OR (s.welcome_claimed_at IS NOT NULL AND s.welcome_claimed_at <= ?1 - ${WELCOME_CLAIM_MS}))
ORDER BY since, s.signup_id`,
    params: NOW,
  },
  signup_cap: {
    sql: `SELECT NULL AS install_id, NULL AS job_id, NULL AS job_kind, NULL AS code, NULL AS message, ${TODAY} AS since FROM (
  SELECT COUNT(*) AS n FROM signups WHERE source = 'self-serve' AND admitted_at >= ${TODAY}
) WHERE ?2 > 0 AND n >= ?2`,
    params: ["now", "signupDailyCap"],
  },
  oauth_register_flood: {
    sql: `SELECT NULL AS install_id, NULL AS job_id, NULL AS job_kind, NULL AS code, NULL AS message, since FROM (
  SELECT COUNT(*) AS n, MIN(registered_at) AS since FROM oauth_clients WHERE registered_at >= ${TODAY}
) WHERE n > ${OAUTH_REGISTER_FLOOD}`,
    params: NOW,
  },
};

/** The bindings for `ALERT_CONDITIONS[key].sql`, in order. */
export function alertParams(key: SqlAlertKey, input: AlertInput): number[] {
  return ALERT_CONDITIONS[key].params.map((p) => input[p]);
}
