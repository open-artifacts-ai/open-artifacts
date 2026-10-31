// Jobs the scheduler inserts (purge after grace, the sweep's cleanup) and
// the Workflow calls it makes. Params are exactly { jobId } (design v7 3.6).
import {
  canonicalJson,
  type JobKind,
  type WorkflowLike,
  WorkflowParamsSchema,
} from "@oa/shared/provisioning";
import { DutyFailure, Stall, within } from "./env.js";

/**
 * The scheduler's principal on the jobs it inserts (design v7 2.3: system
 * actors are `system:<name>`). TODO(contract): C2 exports no system actor
 * key or label.
 */
export const SYSTEM_ACTOR = {
  kind: "system",
  key: "system:scheduler",
  label: "scheduler",
} as const;

/** One Workflow call (create, get, status) past this counts as an rpc_error. */
export const WORKFLOW_CALL_TIMEOUT_MS = 5_000;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID job id: 48-bit time, 80 random bits. TODO(contract): no shared job
 * id generator is exported.
 */
export function newJobId(now: number): string {
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32))
    time = CROCKFORD[t % 32] + time;
  const rnd = crypto.getRandomValues(new Uint8Array(16));
  let rest = "";
  for (const b of rnd) rest += CROCKFORD[b & 31];
  return time + rest;
}

/**
 * body_hash for a job no route accepted. TODO(contract): bodyHash() needs a
 * RouteId and scheduler jobs have none; this hashes the canonical
 * { kind, installId, args } the same way.
 */
export async function systemBodyHash(
  kind: JobKind,
  installId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const data = new TextEncoder().encode(
    canonicalJson({ kind, installId, args }),
  );
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ON CONFLICT DO NOTHING with no target covers every unique index: the
// (actor_key, request_id) idempotency key and jobs_one_active.
const INSERT_JOB = `INSERT INTO jobs (id, kind, workflow, install_id, signup_id, parent_job_id, actor_kind, actor_key, actor_label, request_id, body_hash, args, status, created_at, updated_at)
VALUES (?1, ?2, 'manage_install', ?3, ?4, ?5, '${SYSTEM_ACTOR.kind}', '${SYSTEM_ACTOR.key}', '${SYSTEM_ACTOR.label}', ?6, ?7, '{}', 'queued', ?8, ?8)
ON CONFLICT DO NOTHING RETURNING id`;

export interface SystemJob {
  kind: Extract<JobKind, "purge" | "cleanup">;
  installId: string;
  signupId: string | null;
  parentJobId: string | null;
  requestId: string;
}

/** Inserts a queued manage_install job; its id, or null when one exists. */
export async function insertSystemJob(
  db: D1Database,
  j: SystemJob,
  now: number,
): Promise<string | null> {
  const id = newJobId(now);
  const hash = await systemBodyHash(j.kind, j.installId, {
    parentJobId: j.parentJobId,
    requestId: j.requestId,
  });
  let r: { id: unknown } | null;
  try {
    r = await db
      .prepare(INSERT_JOB)
      .bind(
        id,
        j.kind,
        j.installId,
        j.signupId,
        j.parentJobId,
        j.requestId,
        hash,
        now,
      )
      .first<{ id: unknown }>();
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

/**
 * TODO(contract): WorkflowLike.get has no typed not-found error; the fake
 * and (unverified) the real binding say "not found" in the message.
 */
export function isWorkflowNotFound(e: unknown): boolean {
  return !(e instanceof Stall) && /not[ _]?found/i.test(message(e));
}

const isAlreadyExists = (e: unknown) =>
  !(e instanceof Stall) && /already exists/i.test(message(e));

/**
 * Starts the job's Workflow instance (id = job id). An instance that
 * already exists counts as started. Other failures are rpc_error.
 */
export async function startJob(wf: WorkflowLike, jobId: string): Promise<void> {
  const params = WorkflowParamsSchema.parse({ jobId });
  try {
    await wfCall(() => wf.create({ id: jobId, params }));
  } catch (e) {
    if (isAlreadyExists(e)) return;
    throw new DutyFailure(e instanceof Stall ? "timeout" : "rpc_error");
  }
}
