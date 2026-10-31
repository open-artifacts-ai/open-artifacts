import {
  type Accepted,
  type ApiRouteId,
  bodyHash,
  type JobKind,
  type TransitionActor,
} from "@oa/shared/provisioning";
import { auditStatement } from "../audit.js";
import type { Env } from "../env.js";
import { ApiError } from "../errors.js";
import { ulid } from "../ids.js";
import {
  type JobRow,
  jobOf,
  loadJob,
  loadStatus,
  summaryOf,
} from "../model.js";
import type { Principal } from "../principal.js";
import type { RouteResult, Surface } from "../routes/invoke.js";

// The job model (3.6) and idempotency (3.1): one jobs row per accepted
// write, inserted in one D1 batch with whatever else the write needs and
// its job.accepted audit row, then `<WF>.create({ id: jobId, params: {
// jobId } })`. A failed start leaves the job queued for the scheduler's
// sweep (5.8).

export const REPLAY_HEADER = "oa-idempotent-replay";

/** TRANSITIONS' actor for a principal (5.1): O acts as A within its scope. */
export function transitionActor(p: Principal): TransitionActor {
  if (p.kind === "token") return "T";
  if (p.kind === "user") return "U";
  if (p.kind === "system") return "S";
  return "A";
}

export type Workflow = "provision_install" | "manage_install";
/** create and retry run ProvisionInstall; every other kind ManageInstall. */
export const workflowOf = (kind: JobKind): Workflow =>
  kind === "create" || kind === "retry"
    ? "provision_install"
    : "manage_install";
export const binding = (env: Env, w: JobRow["workflow"]) =>
  w === "provision_install" ? env.PROVISION_INSTALL : env.MANAGE_INSTALL;

export type Write = {
  env: Env;
  principal: Principal;
  surface: Surface;
  route: ApiRouteId;
  requestId: string;
  /** sha256 of canonical { route, installId, body } (bodyHash). */
  hash: string;
};

export async function writeOf(
  env: Env,
  principal: Principal,
  surface: Surface,
  route: ApiRouteId,
  pathId: string | null,
  body: { requestId: string },
): Promise<Write> {
  return {
    env,
    principal,
    surface,
    route,
    requestId: body.requestId,
    hash: await bodyHash(route, pathId, body),
  };
}

const byRequest = (w: Write) =>
  w.env.PLATFORM_DB.prepare(
    "SELECT * FROM jobs WHERE actor_key = ? AND request_id = ?",
  )
    .bind(w.principal.actorKey, w.requestId)
    .first<JobRow>();

/** The 202 body: the job and its install's summary now. */
async function accepted(
  w: Write,
  job: JobRow,
  replay: boolean,
): Promise<RouteResult> {
  const row = await loadStatus(w.env, job.install_id);
  if (!row) throw new ApiError("internal");
  const body: Accepted = { job: jobOf(job), install: summaryOf(w.env, row) };
  return {
    status: 202,
    body,
    headers: replay ? { [REPLAY_HEADER]: "1" } : {},
  };
}

/**
 * The replay check (3.1): the same (actorKey, requestId) and hash is the
 * same job, answered 202 with `oa-idempotent-replay: 1` and audited
 * job.replayed; another hash is 409 idempotency_conflict. Null when the
 * request id is new.
 */
export async function replay(w: Write): Promise<RouteResult | null> {
  const prior = await byRequest(w);
  if (!prior) return null;
  if (prior.body_hash !== w.hash) throw new ApiError("idempotency_conflict");
  await (
    await auditStatement(w.env, {
      action: "job.replayed",
      actor: w.principal,
      outcome: "ok",
      route: w.route,
      installId: prior.install_id,
      jobId: prior.id,
      requestId: w.requestId,
      surface: w.surface,
      detail: { kind: prior.kind },
    })
  ).run();
  return accepted(w, prior, true);
}

export type NewJob = {
  kind: JobKind;
  installId: string;
  /** "self": the job's own id (a create's signup, 0007). */
  signupId?: string | null;
  parentJobId?: string | null;
  /** version, from, to, reason; never an email. */
  args: Record<string, unknown>;
};

export function jobInsert(
  w: Write,
  id: string,
  j: NewJob,
  now: number,
): D1PreparedStatement {
  return w.env.PLATFORM_DB.prepare(
    `INSERT INTO jobs (id, kind, workflow, install_id, signup_id, parent_job_id, actor_kind, actor_key, actor_label, token_id, request_id, body_hash, args, status, created_at, updated_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'queued', ?14, ?14)`,
  ).bind(
    id,
    j.kind,
    workflowOf(j.kind),
    j.installId,
    j.signupId === "self" ? id : (j.signupId ?? null),
    j.parentJobId ?? null,
    w.principal.kind,
    w.principal.actorKey,
    w.principal.label,
    w.principal.tokenId ?? null,
    w.requestId,
    w.hash,
    JSON.stringify(j.args),
    now,
  );
}

export type Accept = {
  job: NewJob;
  /** Rows written in the job's batch, before and after the job row; given the new job id. */
  before?: D1PreparedStatement[];
  after?: (jobId: string) => D1PreparedStatement[];
  /** How a constraint error maps when no row has this request id. */
  onConflict: () => Promise<never>;
  /** Start the job; default: its Workflow with { jobId }. */
  start?: (jobId: string) => Promise<void>;
  /** Audit action; default job.accepted. */
  action?: string;
};

const isConstraint = (e: unknown) =>
  e instanceof Error && /constraint/i.test(e.message);

/**
 * Inserts the job with its rows and audit in one batch, then starts it.
 * Race (3.1): on a constraint error the job is re-read by (actor_key,
 * request_id) first: same hash is a 202 replay, another is
 * idempotency_conflict; only with no such row does `onConflict` map it.
 */
export async function accept(w: Write, a: Accept): Promise<RouteResult> {
  const now = Date.now();
  const id = ulid(now);
  const audit = await auditStatement(w.env, {
    action: a.action ?? "job.accepted",
    actor: w.principal,
    outcome: "ok",
    route: w.route,
    installId: a.job.installId,
    jobId: id,
    requestId: w.requestId,
    surface: w.surface,
    detail: { kind: a.job.kind, args: a.job.args },
  });
  try {
    await w.env.PLATFORM_DB.batch([
      ...(a.before ?? []),
      jobInsert(w, id, a.job, now),
      ...(a.after?.(id) ?? []),
      audit,
    ]);
  } catch (e) {
    if (!isConstraint(e)) throw e;
    const r = await replay(w);
    if (r) return r;
    return a.onConflict();
  }
  const start =
    a.start ??
    ((jobId: string) =>
      binding(w.env, workflowOf(a.job.kind))
        .create({ id: jobId, params: { jobId } })
        .then(() => {}));
  try {
    await start(id);
  } catch {
    // The job stays queued; the scheduler's sweep starts it (3.6, 5.8).
  }
  const job = await loadJob(w.env, id);
  if (!job) throw new ApiError("internal");
  return accepted(w, job, false);
}

/**
 * A batch statement that aborts the whole batch, as a constraint error,
 * unless `existsSql` finds a row: an INSERT of a NULL id (NOT NULL) that
 * runs only when the condition fails. It never writes a row.
 */
export const guard = (env: Env, existsSql: string, ...binds: unknown[]) =>
  env.PLATFORM_DB.prepare(
    `INSERT INTO jobs (id) SELECT NULL WHERE NOT EXISTS (${existsSql})`,
  ).bind(...binds);

/** The install's open job, for job_in_progress after a constraint race. */
export async function activeJobId(
  env: Env,
  installId: string,
): Promise<string | null> {
  const r = await env.PLATFORM_DB.prepare(
    "SELECT id FROM jobs WHERE install_id = ? AND status IN ('queued', 'running')",
  )
    .bind(installId)
    .first<{ id: string }>();
  return r?.id ?? null;
}
