// The job row a Workflow runs (design v7 3.6) and its step wrapper: before
// each step, `step`, `status = 'running'` and `updated_at`; in its catch,
// `attempt`, `last_error_code`, `retry_at` and the redacted message, all
// conditional on the job still being open, so a canceled or settled job is
// never written back to running. Fixed categories only: a step's error is a
// job code (and a terminal refusal's own message), never an error's text.
import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  PROVISION_ERROR_CODES,
  type ProvisionErrorCode,
} from "@oa/provision";
import type { JobKind } from "@oa/shared/provisioning";
import { codeOf, ERROR_MESSAGE_MAX, stepError } from "./errors.js";
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
  args: string;
  status: "queued" | "running" | "done" | "failed";
  step: string | null;
  attempt: number;
  last_error_code: string | null;
  error_code: string | null;
};

/** What a step function reads: the platform D1 and the clock. */
export type StepCtx = { env: { PLATFORM_DB: D1Database }; io: ProvisionerIo };

const JOB =
  "SELECT id, kind, workflow, install_id, signup_id, parent_job_id, actor_kind, args, status, step, attempt, last_error_code, error_code FROM jobs WHERE id = ?";

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
 * updated_at; attempt counts this step's failures, so it starts over at a
 * new step. A job no longer open (an R25 cancel, the sweep) is never
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
      `UPDATE jobs SET attempt = CASE WHEN step IS ?2 THEN attempt ELSE 0 END, step = ?2, status = 'running', retry_at = NULL, started_at = COALESCE(started_at, ?3), updated_at = ?3
WHERE id = ?1 AND status IN ('queued', 'running')`,
    )
      .bind(jobId, name, now)
      .run(),
  );
  if ((r.meta.changes ?? 0) > 0) return;
  const job = await readJob(ctx, jobId);
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
): Promise<void> {
  const terminal = err instanceof NonRetryableError;
  const code = codeOf(err);
  const message = terminal
    ? err.message.slice(0, ERROR_MESSAGE_MAX)
    : (code as string);
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
  retry_at = CASE WHEN ?5 = 0 AND attempt < ?6 THEN ?4 + ${next} ELSE NULL END,
  attempt = attempt + 1
WHERE id = ?1 AND status = 'running'`,
  )
    .bind(jobId, code, message, ctx.io.now(), terminal ? 1 : 0, r.limit)
    .run()
    .catch(() => {});
}

/**
 * One job step: `step.do(name, config?, fn)` with the 3.6 bookkeeping. An
 * error leaves as stepError's (a job code; a terminal refusal keeps its
 * message, `email` scrubbed); a NonRetryableError stays as it is.
 */
export function jobStep<T>(
  ctx: StepCtx,
  step: WorkflowStep,
  jobId: string,
  name: string,
  config: WorkflowStepConfig | undefined,
  fn: () => Promise<T>,
  email: () => string | null = () => null,
): Promise<T> {
  const body = async (): Promise<T> => {
    await markStep(ctx, jobId, name);
    try {
      return await fn();
    } catch (e) {
      const err =
        e instanceof NonRetryableError
          ? e
          : e instanceof Transient
            ? new Error("internal")
            : stepError(e, email());
      await noteFailure(ctx, jobId, err, config);
      throw err;
    }
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

/** A provisioner audit row (hosted_audit; never a secret or an email). */
export function auditStatement(
  ctx: StepCtx,
  installId: string,
  action: string,
  detail: Record<string, string | number>,
): D1PreparedStatement {
  const sorted = Object.fromEntries(
    Object.entries(detail).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return ctx.env.PLATFORM_DB.prepare(
    "INSERT INTO hosted_audit (at, actor, install_id, action, detail) VALUES (?1, 'system:provisioner', ?2, ?3, ?4)",
  ).bind(ctx.io.now(), installId, action, JSON.stringify(sorted));
}
