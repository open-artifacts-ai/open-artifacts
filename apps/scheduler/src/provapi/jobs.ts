// Jobs the scheduler inserts (purge after grace, the sweep's cleanup) and
// the Workflow calls it makes. Params are exactly { jobId } (design v7 3.6).
import type { WorkflowParams } from "@oa/shared/provisioning";
import {
  newJobId,
  SYSTEM_ACTOR,
  type SystemJobArgs,
  type SystemJobKind,
  systemJobBodyHash,
} from "@oa/shared/provisioning/system";
import {
  isWorkflowNotFound,
  type WorkflowLike,
} from "@oa/shared/provisioning/workflow";
import { DutyFailure, Stall, within } from "./env.js";

export { isWorkflowNotFound };

/** One Workflow call (create, get, status) past this counts as an rpc_error. */
export const WORKFLOW_CALL_TIMEOUT_MS = 5_000;

// ON CONFLICT DO NOTHING with no target covers every unique index: the
// (actor_key, request_id) idempotency key and jobs_one_active. The guard is
// checked in the same statement, so what it reads cannot change between
// the check and the insert. (SQLite needs a WHERE on an INSERT ... SELECT
// with ON CONFLICT.)
const insertJob = (guard: string) =>
  `INSERT INTO jobs (id, kind, workflow, install_id, signup_id, parent_job_id, actor_kind, actor_key, actor_label, request_id, body_hash, args, status, created_at, updated_at)
SELECT ?1, ?2, 'manage_install', ?3, ?4, ?5, '${SYSTEM_ACTOR.kind}', '${SYSTEM_ACTOR.key}', '${SYSTEM_ACTOR.label}', ?6, ?7, ?10, 'queued', ?8, ?8
WHERE ${guard}
ON CONFLICT DO NOTHING RETURNING id`;

export type SystemJob = {
  [K in SystemJobKind]: {
    kind: K;
    installId: string;
    signupId: string | null;
    parentJobId: string | null;
    requestId: string;
    /** `jobs.args`, also hashed into `jobs.body_hash` (systemJobBodyHash). */
    args: SystemJobArgs[K];
  };
}[SystemJobKind];

/**
 * A condition the insert also needs: SQL over the insert's own params (?3
 * install id, ?5 parent job id, ?8 now) plus `params` bound from ?9 on.
 * ?10 is the args JSON, so a guard binds at most one param (?9).
 */
export interface JobGuard {
  sql: string;
  params: readonly unknown[];
}

const NO_GUARD: JobGuard = { sql: "1", params: [] };

/** The insert of a queued manage_install job, not yet run. */
export async function systemJobStatement(
  db: D1Database,
  j: SystemJob,
  now: number,
  guard: JobGuard = NO_GUARD,
): Promise<D1PreparedStatement> {
  if (guard.params.length > 1)
    throw new Error("systemJobStatement: a guard binds at most ?9");
  const hash = await systemJobBodyHash(j.kind, j.installId, j.args as never);
  return db
    .prepare(insertJob(guard.sql))
    .bind(
      newJobId(now),
      j.kind,
      j.installId,
      j.signupId,
      j.parentJobId,
      j.requestId,
      hash,
      now,
      guard.params[0] ?? null,
      JSON.stringify(j.args),
    );
}

/**
 * Inserts a queued manage_install job; its id, or null when one exists or
 * the guard does not hold.
 */
export async function insertSystemJob(
  db: D1Database,
  j: SystemJob,
  now: number,
  guard: JobGuard = NO_GUARD,
): Promise<string | null> {
  let r: { id: unknown } | null;
  try {
    r = await (await systemJobStatement(db, j, now, guard)).first<{
      id: unknown;
    }>();
  } catch {
    throw new DutyFailure("db_error");
  }
  return typeof r?.id === "string" ? r.id : null;
}

/** A Workflow call bounded by WORKFLOW_CALL_TIMEOUT_MS; any failure rethrown as is. */
export function wfCall<T>(
  f: () => Promise<T>,
  ms = WORKFLOW_CALL_TIMEOUT_MS,
): Promise<T> {
  return within(Promise.resolve().then(f), ms);
}

const message = (e: unknown) =>
  e instanceof Error ? e.message : typeof e === "string" ? e : "";

// isWorkflowNotFound (C5) matches only WorkflowNotFoundError, never a
// message, so anything else fails closed (rpc_error, the job left alone).
// UNVERIFIED for the real Cloudflare binding: what its get() throws for an
// unknown id is not checked, and nothing here translates it yet, so until a
// wrapper does, a real missing instance is an rpc_error (never settled or
// started by the sweep).

// TODO(contract): no typed "already exists" error for WorkflowLike.create;
// this matches the fake's and the binding's message.
const isAlreadyExists = (e: unknown) =>
  !(e instanceof Stall) && /already exists/i.test(message(e));

/**
 * Starts the job's Workflow instance (id = job id). An instance that
 * already exists counts as started. Other failures are rpc_error.
 */
export async function startJob(wf: WorkflowLike, jobId: string): Promise<void> {
  const params: WorkflowParams = { jobId };
  try {
    await wfCall(() => wf.create({ id: jobId, params }));
  } catch (e) {
    if (isAlreadyExists(e)) return;
    throw new DutyFailure(e instanceof Stall ? "timeout" : "rpc_error");
  }
}
