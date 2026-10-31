// Job codes, refusals and settleFailed (design v7 3.5, 3.6): node-free, so
// the provisioning and scheduler Workers import them (`@oa/provision/jobs`)
// without the WfpProvisioner module.

/** A Cloudflare API call that failed (HTTP error or network). */
export class CfError extends Error {
  override name = "CfError";
  constructor(
    readonly method: string,
    readonly route: string,
    readonly status: number,
    /** Cloudflare's error codes and messages (never the request body). */
    readonly cfMessage: string,
  ) {
    super(
      `Cloudflare ${method} ${route}: HTTP ${status}${cfMessage ? ` (${cfMessage})` : ""}`,
    );
  }
}

/**
 * Every job error code (design v7 3.5, `JobErrorCode`): a ProvisionRefused
 * carries one where it is thrown, and classification reads that property,
 * never the message.
 */
export const PROVISION_ERROR_CODES = Object.freeze([
  "release_not_published",
  "release_unverified",
  "downgrade_refused",
  "prod_dirty",
  "invalid_state",
  "slug_taken",
  "lease_held",
  "revoke_pending",
  "token_invalid",
  "upgrade_rolled_back",
  "upgrade_incomplete",
  "canceled",
  // A dead Workflow run (errored, terminated, or complete with the job still
  // open): set only by the scheduler sweep through settleFailed. Terminal;
  // job_failed alerts and the sweep's cleanup job still runs.
  "run_dead",
  "cf_error",
  "internal",
] as const);
export type ProvisionErrorCode = (typeof PROVISION_ERROR_CODES)[number];

/** The codes a ProvisionRetry carries: a rerun may succeed (bounded backoff). */
export const PROVISION_RETRY_CODES = Object.freeze([
  "lease_held",
  "revoke_pending",
  "token_invalid",
] as const);
export type ProvisionRetryCode = (typeof PROVISION_RETRY_CODES)[number];

/** Every job kind (design v7 3.2 `JobKindSchema`). */
export const PROVISION_JOB_KINDS = Object.freeze([
  "create",
  "retry",
  "upgrade",
  "rollback",
  "suspend",
  "resume",
  "delete",
  "restore",
  "purge",
  "discard",
  "release_lease",
  "cleanup",
  "redline_creds",
] as const);
export type ProvisionJobKind = (typeof PROVISION_JOB_KINDS)[number];

/**
 * What each job kind does with a token within REFUSE_TOKEN_DAYS of its end
 * date (design v7 5.7): forward changes refuse, recovery goes on with a
 * WARNING note. Passed to verifyToken and the operations' nearExpiry.
 */
export const NEAR_EXPIRY_MODE: Readonly<
  Record<ProvisionJobKind, "refuse" | "warn">
> = Object.freeze({
  create: "refuse",
  retry: "refuse",
  upgrade: "refuse",
  resume: "refuse",
  restore: "refuse",
  redline_creds: "refuse",
  suspend: "warn",
  delete: "warn",
  purge: "warn",
  discard: "warn",
  release_lease: "warn",
  rollback: "warn",
  cleanup: "warn",
});

/** The platform D1 as a Worker binding sees it (the subset settleFailed uses). */
export interface SettleDb {
  prepare(sql: string): { bind(...values: unknown[]): unknown };
  batch(statements: unknown[]): Promise<unknown>;
}

/** settleFailed's options. */
export interface SettleOptions {
  /**
   * Prepared statements on the same `db`, run after the settle's own
   * statements in its one D1 batch (the sweep's cleanup-job insert), so the
   * settle and they commit or fail together. They run even when the job was
   * already settled, and always after the settle UPDATE, so the parent is
   * `failed` by then whoever settled it: a guard on the parent's status
   * cannot tell this call's settle from an R25 cancel that already settled
   * the job and queued its own cleanup. So every extra must
   * - guard on the parent having been settled with exactly the code this
   *   call wrote (`settledWith(parentSql, code)`, e.g. `run_dead` for the
   *   sweep); a cancel's `canceled` never matches, and
   * - be `INSERT OR IGNORE`, so `jobs_one_active` (a cleanup already open)
   *   and `(actor_key, request_id)` (an earlier tick's `cleanup-<jobId>`)
   *   skip the row instead of failing the batch.
   */
  extra?: readonly unknown[];
}

/**
 * The SQL guard for a settleFailed extra: true iff the parent job is failed
 * with exactly `code`, the code this settle call wrote. `parentSql` is a
 * `?N` bind placeholder or `<alias>.<column>` of the outer query, with an
 * alias other than `jobs` and `p` (the guard's own table): an unqualified
 * or self-qualified column would read the subquery's own row (`p.id =
 * p.id`), true whenever any job has `code`, so it is refused.
 */
export function settledWith(
  parentSql: string,
  code: ProvisionErrorCode,
): string {
  if (!(PROVISION_ERROR_CODES as readonly string[]).includes(code))
    throw new Error(`unknown provision error code ${String(code)}`);
  const m =
    /^(?:\?[1-9]\d{0,2}|([A-Za-z_][A-Za-z0-9_]*)\.[a-z_][a-z0-9_]*)$/.exec(
      parentSql,
    );
  const alias = m?.[1]?.toLowerCase();
  if (!m || alias === "jobs" || alias === "p")
    throw new Error(
      "settledWith: parentSql must be a ?N placeholder or <alias>.<column> (alias not jobs or p)",
    );
  return `EXISTS (SELECT 1 FROM jobs p WHERE p.id = ${parentSql} AND p.status = 'failed' AND p.error_code = '${code}')`;
}

/** What settleFailed did. */
export interface SettleResult {
  /** True iff this call moved the job to failed (the jobs row changed). */
  settled: boolean;
  /** The D1 batch results of `extra`, in order ([] without it). */
  extra: unknown[];
}

// The job's settle runs first: a job the same batch then inserts for the
// install (a cleanup, a purge) fits jobs_one_active. The job update is
// conditional on it being open, so a stored code (an R25 cancel's) is never
// overwritten; the signup and the account claim follow the job once it is
// failed, by whichever settle gets there.
const SETTLE_JOB = `UPDATE jobs SET status = 'failed', error_code = COALESCE(error_code, ?2), error_message = COALESCE(error_message, ?2), finished_at = COALESCE(finished_at, ?3), retry_at = NULL, updated_at = ?3
WHERE id = ?1 AND status IN ('queued', 'running')`;
// Only the signup whose current job this is (a retry moves job_id on).
const SETTLE_SIGNUP = `UPDATE signups SET status = 'failed', error = COALESCE(error, (SELECT error_code FROM jobs WHERE id = ?1)), updated_at = ?2
WHERE job_id = ?1 AND status NOT IN ('ready', 'failed')
  AND EXISTS (SELECT 1 FROM jobs WHERE id = ?1 AND status = 'failed')`;
// A self-serve install that was never created (no installs row) frees the
// account's one-install claim; one with an installs row keeps it until purge.
const FREE_ACCOUNT = `UPDATE signup_accounts SET freed_at = ?2
WHERE freed_at IS NULL
  AND signup_id = (SELECT signup_id FROM signups WHERE job_id = ?1 AND source = 'self-serve' AND status = 'failed')
  AND NOT EXISTS (SELECT 1 FROM installs WHERE id = (SELECT install_id FROM jobs WHERE id = ?1))`;

const checkCode = (code: unknown): void => {
  if (!(PROVISION_ERROR_CODES as readonly string[]).includes(code as string))
    throw new Error(`unknown provision error code ${String(code)}`);
};

/**
 * settleFailed's statements, in order, for a caller that adds its own to
 * the same batch (the create fail step's snapshot and purge job).
 */
export function settleFailedStatements<S>(
  db: { prepare(sql: string): { bind(...values: unknown[]): S } },
  jobId: string,
  code: ProvisionErrorCode,
  now: number = Date.now(),
): S[] {
  checkCode(code);
  return [
    db.prepare(SETTLE_JOB).bind(jobId, code, now),
    db.prepare(SETTLE_SIGNUP).bind(jobId, now),
    db.prepare(FREE_ACCOUNT).bind(jobId, now),
  ];
}

/**
 * Settles a failed job (design v7 3.6), shared by every fail step, cancel
 * and the scheduler sweep: `jobs` to failed with `code` (never over a stored
 * code), `signups.status = failed`, and `signup_accounts` freed for a
 * self-serve install that was never created. One D1 batch on `db` (the
 * platform D1 binding), with `opts.extra` appended. `settled` reads the
 * jobs UPDATE's `meta.changes`: false when the job was no longer open.
 */
export async function settleFailed(
  db: SettleDb,
  jobId: string,
  code: ProvisionErrorCode,
  opts?: SettleOptions,
): Promise<SettleResult> {
  checkCode(code);
  if (opts?.extra !== undefined && !Array.isArray(opts.extra))
    throw new Error("settleFailed: extra must be an array of statements");
  // TODO(C6): expectCode (`error_code IS ?` compare-and-set) lands with C6.
  const own = settleFailedStatements(db, jobId, code, Date.now());
  const extra = opts?.extra ?? [];
  const results = (await db.batch([...own, ...extra])) as
    | readonly unknown[]
    | undefined;
  const first = results?.[0] as { meta?: { changes?: number } } | undefined;
  return {
    settled: (first?.meta?.changes ?? 0) > 0,
    extra: results ? results.slice(own.length) : [],
  };
}
export type SettleFailed = typeof settleFailed;

export class ProvisionRefused extends Error {
  override name = "ProvisionRefused";
  /** The job error code, set where it is thrown (design v7 3.5); required. */
  readonly code: ProvisionErrorCode;
  constructor(message: string, code: ProvisionErrorCode) {
    super(message);
    if (!(PROVISION_ERROR_CODES as readonly string[]).includes(code))
      throw new Error(`unknown provision error code ${String(code)}`);
    this.code = code;
  }
}

/**
 * A refusal a rerun may clear (a held lease, a pending directory revoke, a
 * token that is not active): the Workflow retries it with bounded backoff.
 */
export class ProvisionRetry extends ProvisionRefused {
  override name = "ProvisionRetry";
  declare readonly code: ProvisionRetryCode;
  constructor(message: string, code: ProvisionRetryCode) {
    if (!(PROVISION_RETRY_CODES as readonly string[]).includes(code))
      throw new Error(`${String(code)} is not a retry code`);
    super(message, code);
  }
}

/**
 * The job error code for anything an operation threw (design v7 3.5): a
 * ProvisionRefused's own code (always set), `cf_error` for a Cloudflare API
 * error, and `internal` for everything else. W3 and W7
 * classify through this, never a message.
 */
export function provisionErrorCode(e: unknown): ProvisionErrorCode {
  if (e instanceof ProvisionRefused) return e.code;
  if (e instanceof CfError) return "cf_error";
  return "internal";
}
