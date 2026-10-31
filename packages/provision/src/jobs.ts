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
   * already settled; guard them in SQL (e.g. on the parent's status).
   */
  extra?: readonly unknown[];
}

/** What settleFailed did. */
export interface SettleResult {
  /** True iff this call moved the job to failed (the jobs row changed). */
  settled: boolean;
  /** The D1 batch results of `extra`, in order ([] without it). */
  extra: unknown[];
}

/**
 * Settles a failed job (design v7 3.6), shared by every fail step, cancel
 * and the scheduler sweep: `jobs` to failed with `code` (never over a stored
 * code), `signups.status = failed`, and `signup_accounts` freed for a
 * self-serve install that was never created. One D1 batch on `db` (the
 * platform D1 binding), with `opts.extra` appended. `settled` reads the
 * jobs UPDATE's `meta.changes`: false when the job was no longer open. W3
 * builds the body; until then it throws.
 */
export async function settleFailed(
  db: SettleDb,
  jobId: string,
  code: ProvisionErrorCode,
  opts?: SettleOptions,
): Promise<SettleResult> {
  void db;
  if (!(PROVISION_ERROR_CODES as readonly string[]).includes(code))
    throw new Error(`unknown provision error code ${String(code)}`);
  if (opts?.extra !== undefined && !Array.isArray(opts.extra))
    throw new Error("settleFailed: extra must be an array of statements");
  throw new Error(`settleFailed is not built yet (W3); job ${jobId}`);
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
