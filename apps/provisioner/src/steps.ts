// The job row a Workflow runs (design v7 3.6) and its step wrapper: before
// each step, `step`, `status = 'running'` and `updated_at`; in its catch,
// `attempt`, `last_error_code`, `retry_at` and the redacted message, all
// conditional on the job still being open, so a canceled or settled job is
// never written back to running. Fixed categories only: a step's error is a
// job code, and jobs.error_message that code's JOB_ERROR_TEXT, never an
// error's text.
import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { PROVISION_ERROR_CODES, type ProvisionErrorCode } from "@oa/provision";
import type { JobKind } from "@oa/shared/provisioning";
import { codeOf, JOB_ERROR_TEXT, stepError } from "./errors.js";
import { type ProvisionerIo, Transient, transient } from "./provisioner.js";

/** The jobs row a step reads (0008); never an email. */
export type JobRow = {
  id: string;
  kind: JobKind;
  workflow: "provision_install" | "manage_install" | "none";
  install_id: string;
  signup_id: string | null;
  parent_job_id: string | null;
  actor_kind: "admin" | "token" | "user" | "oidc" | "system";
  request_id: string;
  args: string;
  status: "queued" | "running" | "done" | "failed";
  step: string | null;
  attempt: number;
  last_error_code: string | null;
  error_code: string | null;
  started_at: number | null;
};

/** What a step function reads: the platform D1 and the clock. */
export type StepCtx = { env: { PLATFORM_DB: D1Database }; io: ProvisionerIo };

const JOB =
  "SELECT id, kind, workflow, install_id, signup_id, parent_job_id, actor_kind, request_id, args, status, step, attempt, last_error_code, error_code, started_at FROM jobs WHERE id = ?";

export async function readJob(
  ctx: StepCtx,
  jobId: string,
): Promise<JobRow | null> {
  return transient(
    ctx.env.PLATFORM_DB.prepare(JOB).bind(jobId).first<JobRow>(),
  );
}

/** The job's args object (version, from, to, reason; never an email). */
export function argsOf(job: JobRow): Record<string, unknown> {
  try {
    const a = JSON.parse(job.args) as unknown;
    if (a && typeof a === "object" && !Array.isArray(a))
      return a as Record<string, unknown>;
  } catch {}
  throw new NonRetryableError("invalid_state: the job args are not an object");
}

/** A job code, or `internal` for anything else (a stored value is a request). */
export const jobCode = (v: unknown): ProvisionErrorCode =>
  (PROVISION_ERROR_CODES as readonly string[]).includes(v as string)
    ? (v as ProvisionErrorCode)
    : "internal";

// The Workflows default for a step with no config: 5 retries, 10 s,
// exponential.
const DEFAULT_RETRIES = { limit: 5, delay: 10_000, backoff: "exponential" };

const UNIT_MS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
};
/** A step's retry delay in ms ("30 seconds", "1 minute", or a number). */
export function delayMs(d: string | number): number {
  if (typeof d === "number") return d;
  const m = /^(\d+) (second|minute|hour)s?$/.exec(d);
  if (!m) throw new Error(`unknown delay ${d}`);
  return Number(m[1]) * (UNIT_MS[m[2] as string] as number);
}

/**
 * Records that the job is at `name`: step, running, started_at once,
 * updated_at. A job no longer open (an R25 cancel, the sweep) is never
 * reopened: the step fails for good with its stored code.
 */
export async function markStep(
  ctx: StepCtx,
  jobId: string,
  name: string,
): Promise<void> {
  const now = ctx.io.now();
  const r = await transient(
    ctx.env.PLATFORM_DB.prepare(
      `UPDATE jobs SET step = ?2, status = 'running', retry_at = NULL, started_at = COALESCE(started_at, ?3), updated_at = ?3
WHERE id = ?1 AND status IN ('queued', 'running')`,
    )
      .bind(jobId, name, now)
      .run(),
  );
  if ((r.meta.changes ?? 0) > 0) return;
  const job = await readJob(ctx, jobId);
  // A replay of the last step after its result was lost: nothing to reopen.
  if (job?.status === "done" && name === "done") return;
  throw new NonRetryableError(
    job?.status === "failed" ? jobCode(job.error_code) : "internal",
  );
}

/** The failure of one attempt, on the row (best effort: never masks `err`). */
async function noteFailure(
  ctx: StepCtx,
  jobId: string,
  err: Error,
  config: WorkflowStepConfig | undefined,
  retryIn: number | null = null,
): Promise<void> {
  const terminal = err instanceof NonRetryableError;
  const code = codeOf(err);
  // The code's fixed text: a refusal's message can echo request values.
  const message = JOB_ERROR_TEXT[code];
  const r = { ...DEFAULT_RETRIES, ...(config?.retries ?? {}) };
  const base = typeof r.delay === "function" ? 0 : delayMs(r.delay);
  // retry_at for the next attempt: delay, then doubled (exponential),
  // added (linear) or the same; none once the step is out of retries.
  const next =
    r.backoff === "exponential"
      ? `${base} * (1 << attempt)`
      : r.backoff === "linear"
        ? `${base} * (attempt + 1)`
        : `${base}`;
  await ctx.env.PLATFORM_DB.prepare(
    `UPDATE jobs SET last_error_code = ?2, error_message = ?3, updated_at = ?4,
  retry_at = CASE WHEN ?7 IS NOT NULL THEN ?4 + ?7 WHEN ?5 = 0 AND attempt < ?6 THEN ?4 + ${next} ELSE NULL END,
  attempt = attempt + 1
WHERE id = ?1 AND status = 'running'`,
  )
    .bind(
      jobId,
      code,
      message,
      ctx.io.now(),
      terminal ? 1 : 0,
      r.limit,
      retryIn,
    )
    .run()
    .catch(() => {});
}

/** 3.5: a Cloudflare token not active is retried every 15 min, up to 2 h. */
export const TOKEN_WAIT = "15 minutes";
export const TOKEN_WAITS = 8;
// The step's error while it waits for the token (its own text, so a stored
// token_invalid that markStep rethrows never waits).
const TOKEN_WAITING =
  "token_invalid: the Cloudflare token is not active; retrying in 15 minutes";

/**
 * One job step: `step.do(name, config?, fn)` with the 3.6 bookkeeping. An
 * error leaves as stepError's (a job code and its fixed text); a
 * NonRetryableError stays as it is. `mark` is
 * the JOB_STEPS value written to jobs.step (the step's name by default).
 * token_invalid skips the step's own retries: the step is run again as
 * `<name>_token<n>` after a TOKEN_WAIT sleep, TOKEN_WAITS times, and the
 * last run keeps the step's config.
 */
export async function jobStep<T>(
  ctx: StepCtx,
  step: WorkflowStep,
  jobId: string,
  name: string,
  config: WorkflowStepConfig | undefined,
  fn: () => Promise<T>,
  mark: string = name,
): Promise<T> {
  for (let round = 0; ; round++) {
    const n = round === 0 ? name : `${name}_token${round}`;
    try {
      return await stepOnce(ctx, step, jobId, n, config, fn, mark, {
        wait: round < TOKEN_WAITS,
      });
    } catch (e) {
      if ((e as Error | null)?.message !== TOKEN_WAITING) throw e;
      await step.sleep(`${name}_token_wait${round + 1}`, TOKEN_WAIT);
    }
  }
}

function stepOnce<T>(
  ctx: StepCtx,
  step: WorkflowStep,
  jobId: string,
  name: string,
  config: WorkflowStepConfig | undefined,
  fn: () => Promise<T>,
  mark: string,
  o: { wait: boolean },
): Promise<T> {
  const body = async (): Promise<T> => {
    await markStep(ctx, jobId, mark);
    let out: T;
    try {
      out = await fn();
    } catch (e) {
      let err =
        e instanceof NonRetryableError
          ? e
          : e instanceof Transient
            ? new Error("internal")
            : stepError(e);
      const waits =
        o.wait &&
        !(e instanceof NonRetryableError) &&
        codeOf(err) === "token_invalid";
      if (waits) err = new NonRetryableError(TOKEN_WAITING);
      await noteFailure(
        ctx,
        jobId,
        err,
        config,
        waits ? delayMs(TOKEN_WAIT) : null,
      );
      throw err;
    }
    // attempt counts the failures of the step running now (3.6, the
    // job_retrying alert): a step that succeeded starts it over.
    await transient(
      ctx.env.PLATFORM_DB.prepare(
        "UPDATE jobs SET attempt = 0, updated_at = ?2 WHERE id = ?1 AND status = 'running' AND attempt <> 0",
      )
        .bind(jobId, ctx.io.now())
        .run(),
    );
    return out;
  };
  return (
    config === undefined
      ? step.do(name, body as () => Promise<never>)
      : step.do(name, config, body as () => Promise<never>)
  ) as Promise<T>;
}

/** The job done, with its step; only while it is open. */
export function doneStatement(
  ctx: StepCtx,
  jobId: string,
): D1PreparedStatement {
  return ctx.env.PLATFORM_DB.prepare(
    `UPDATE jobs SET status = 'done', step = 'done', retry_at = NULL, finished_at = ?2, updated_at = ?2
WHERE id = ?1 AND status IN ('queued', 'running')`,
  ).bind(jobId, ctx.io.now());
}

/**
 * A provisioner audit row (hosted_audit; never a secret or an email), as
 * `job:<jobId>` (4.9, PlatformDb.auditAs), only while that job is still
 * open, so a retried batch that already settled it appends nothing
 * (hosted_audit is append-only).
 */
export function auditStatement(
  ctx: StepCtx,
  installId: string,
  action: string,
  detail: Record<string, string | number>,
  jobId: string,
): D1PreparedStatement {
  const sorted = Object.fromEntries(
    Object.entries(detail).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return ctx.env.PLATFORM_DB.prepare(
    "INSERT INTO hosted_audit (at, actor, install_id, action, detail) SELECT ?1, ?5, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ?6 AND status IN ('queued', 'running'))",
  ).bind(
    ctx.io.now(),
    installId,
    action,
    JSON.stringify(sorted),
    `job:${jobId}`,
    jobId,
  );
}

/** `job.done` with the job's kind (4.9), only while the job is open. */
export function doneAuditStatement(
  ctx: StepCtx,
  job: { jobId: string; kind: string; installId: string },
): D1PreparedStatement {
  return auditStatement(
    ctx,
    job.installId,
    "job.done",
    { jobId: job.jobId, kind: job.kind },
    job.jobId,
  );
}

/**
 * `job.failed` with its kind and code (4.9), only while the job is open: put
 * before the settle in the same batch, it follows only the settle that
 * moves the job to failed (not a cancel's, nor a retried fail step's).
 */
export function failedAuditStatement(
  ctx: StepCtx,
  job: { id: string; kind: string; install_id: string },
  code: string,
): D1PreparedStatement {
  return auditStatement(
    ctx,
    job.install_id,
    "job.failed",
    { code, jobId: job.id, kind: job.kind },
    job.id,
  );
}
