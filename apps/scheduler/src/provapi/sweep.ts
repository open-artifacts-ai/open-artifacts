// Job sweep (design v7 5.8): start open jobs whose Workflow instance never
// started, and settle jobs whose run is dead, each with one cleanup job
// (lease, owner tokens, signups) on ManageInstall, inserted in the settle's
// own D1 batch.
import {
  type ProvisionErrorCode,
  settleFailed as realSettleFailed,
  type SettleDb,
  type SettleFailed,
} from "@oa/provision/jobs";
import type {
  WorkflowInstanceStatus,
  WorkflowLike,
} from "@oa/shared/provisioning";
import {
  bound,
  DutyFailure,
  d1,
  lanes,
  type ProvapiEnv,
  Stall,
} from "./env.js";
import {
  insertSystemJob,
  isWorkflowNotFound,
  type JobGuard,
  type SystemJob,
  startJob,
  systemJobStatement,
  wfCall,
} from "./jobs.js";
import { dutyCategory } from "./run.js";

/** Jobs looked at per tick in each list (unstarted, then all open). */
export const SWEEP_LIMIT = 50;
/** Workflow calls in flight per tick. */
export const SWEEP_CONCURRENCY = 3;
/**
 * A queued job with no instance this old is started by the sweep, so it
 * never races the API's own Workflow.create. TODO(contract): no exported
 * start-grace constant and no `started` marker on jobs.
 */
export const START_GRACE_MS = 2 * 60_000;
/**
 * The code a dead run settles with. TODO(contract): PROVISION_ERROR_CODES
 * has none for a dead Workflow run (errored, terminated, or complete with
 * the job still open).
 */
export const DEAD_RUN_CODE: ProvisionErrorCode = "internal";

const COLS =
  "id, kind, workflow, install_id, signup_id, status, created_at FROM jobs";
// Queued past the start grace, oldest first: its own list, so open jobs
// with long runs or retries never crowd out a create the API failed to start.
const UNSTARTED = `SELECT ${COLS} WHERE status = 'queued' AND workflow <> 'none' AND created_at <= ?1 ORDER BY created_at, id LIMIT ?2`;
// Every other open job, least recently changed first: dead runs. The two
// lists never overlap.
const OPEN_JOBS = `SELECT ${COLS} WHERE status IN ('queued', 'running') AND workflow <> 'none' AND NOT (status = 'queued' AND created_at <= ?1) ORDER BY updated_at, id LIMIT ?2`;

interface OpenJob {
  id: string;
  kind: string;
  workflow: string;
  install_id: string;
  signup_id: string | null;
  status: "queued" | "running";
  created_at: number;
}

export interface SweepDeps {
  /** Tests only, and until W3 builds settleFailed (today it throws). */
  settleFailed?: SettleFailed;
}

const DEAD = new Set<WorkflowInstanceStatus["status"]>([
  "errored",
  "terminated",
]);

const STILL_OPEN =
  "SELECT 1 AS open FROM jobs WHERE id = ?1 AND status IN ('queued', 'running')";
const stillOpen = async (db: D1Database, id: string) =>
  (await d1(db.prepare(STILL_OPEN).bind(id).first())) !== null;

// The cleanup goes in only when its parent settled failed (?5 parent).
const PARENT_FAILED: JobGuard = {
  sql: "EXISTS (SELECT 1 FROM jobs WHERE id = ?5 AND status = 'failed')",
  params: [],
};

/**
 * The platform D1 for settleFailed, with `extra` appended to its batch: the
 * settle and the cleanup insert are one D1 batch (design v7 3.6), so a
 * failure, an evicted tick or another job opening in between never leaves
 * a failed job without its cleanup. `inserted()` is the cleanup's id when
 * that batch inserted it; `batched()` says whether settleFailed batched.
 */
function withCleanup(db: D1Database, extra: D1PreparedStatement | null) {
  let batched = false;
  let inserted: string | null = null;
  const wrapped: SettleDb = {
    prepare: (sql) => db.prepare(sql),
    batch: async (st) => {
      if (batched || extra === null)
        return db.batch(st as D1PreparedStatement[]);
      batched = true;
      const res = await db.batch([...(st as D1PreparedStatement[]), extra]);
      const id = (res.at(-1)?.results[0] as { id?: unknown } | undefined)?.id;
      inserted = typeof id === "string" ? id : null;
      return res;
    },
  };
  return {
    db: wrapped,
    batched: () => batched,
    inserted: () => inserted,
  };
}

/** What one open job needs: start it, settle it, or nothing. */
async function look(
  wf: WorkflowLike,
  j: OpenJob,
  now: number,
): Promise<"start" | "dead" | "alive"> {
  let status: WorkflowInstanceStatus["status"];
  try {
    const inst = await wfCall(() => wf.get(j.id));
    status = (await wfCall(() => inst.status())).status;
  } catch (e) {
    if (!isWorkflowNotFound(e))
      throw new DutyFailure(e instanceof Stall ? "timeout" : "rpc_error");
    if (j.status === "running") return "dead";
    return j.created_at <= now - START_GRACE_MS ? "start" : "alive";
  }
  if (DEAD.has(status) || status === "complete") return "dead";
  return "alive";
}

export async function sweep(
  env: ProvapiEnv,
  now: number,
  { settleFailed = realSettleFailed }: SweepDeps = {},
): Promise<void> {
  const db = env.PLATFORM_DB;
  const flows: Record<string, WorkflowLike> = {
    provision_install: bound(env.PROVISION_INSTALL),
    manage_install: bound(env.MANAGE_INSTALL),
  };
  const manage = flows.manage_install as WorkflowLike;
  const [unstarted, open] = await d1(
    db.batch<OpenJob>([
      db.prepare(UNSTARTED).bind(now - START_GRACE_MS, SWEEP_LIMIT),
      db.prepare(OPEN_JOBS).bind(now - START_GRACE_MS, SWEEP_LIMIT),
    ]),
  );
  const todo = [...(unstarted?.results ?? []), ...(open?.results ?? [])];
  const one = async (j: OpenJob) => {
    const wf = flows[j.workflow];
    if (!wf) return;
    let step = "status";
    try {
      const what = await look(wf, j, now);
      if (what === "start") {
        step = "start";
        await startJob(wf, j.id);
        console.log("provapi sweep started", j.id);
        return;
      }
      if (what !== "dead") return;
      step = "settle";
      // The run may have settled the job itself since the select (a
      // complete run's last step marks it done): still open, or leave it.
      if (!(await stillOpen(db, j.id))) return;
      // A dead cleanup is settled only, never given another cleanup.
      const cleanup: SystemJob | null =
        j.kind === "cleanup"
          ? null
          : {
              kind: "cleanup",
              installId: j.install_id,
              signupId: j.signup_id,
              parentJobId: j.id,
              requestId: `cleanup-${j.id}`,
            };
      const w = withCleanup(
        db,
        cleanup && (await systemJobStatement(db, cleanup, now, PARENT_FAILED)),
      );
      // TODO(contract): settleFailed does not say whether it settled.
      await settleFailed(w.db, j.id, DEAD_RUN_CODE);
      if (await stillOpen(db, j.id)) return;
      console.warn("provapi sweep settled", j.id, DEAD_RUN_CODE);
      if (cleanup === null) return;
      step = "cleanup";
      // A settleFailed that never batched: insert it on its own.
      const id = w.batched()
        ? w.inserted()
        : await insertSystemJob(db, cleanup, now, PARENT_FAILED);
      // null: an overlapping tick (or another open job) got there first.
      if (id === null) return;
      console.log("provapi sweep cleanup", id, j.id);
      // A failed start leaves it queued; the next sweep starts it.
      await startJob(manage, id);
    } catch (e) {
      console.error("provapi sweep", `${step}_failed`, dutyCategory(e), j.id);
    }
  };
  await lanes(todo, SWEEP_CONCURRENCY, one);
}
