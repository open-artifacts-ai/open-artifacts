// Job sweep (design v7 5.8): start open jobs whose Workflow instance never
// started, and settle jobs whose run is dead, each with one cleanup job
// (lease, owner tokens, signups) on ManageInstall, inserted in the settle's
// own D1 batch.
import {
  type ProvisionErrorCode,
  settleFailed as realSettleFailed,
  type SettleFailed,
  settledWith,
} from "@oa/provision/jobs";
import {
  JOB_START_GRACE_MS,
  JOB_TERMINATED_GRACE_MS,
  SWEEP_CURSOR_KEY,
  SWEEP_TERMINATED_PREFIX,
  sweepTerminatedKey,
} from "@oa/shared/provisioning/state";
import { cleanupRequestId } from "@oa/shared/provisioning/system";
import type {
  WorkflowInstanceStatus,
  WorkflowLike,
} from "@oa/shared/provisioning/workflow";
import {
  bound,
  DutyFailure,
  d1,
  lanes,
  type ProvapiEnv,
  Stall,
} from "./env.js";
import {
  isWorkflowNotFound,
  type JobGuard,
  type SystemJob,
  startJob,
  systemJobStatement,
  wfCall,
} from "./jobs.js";
import { dutyCategory } from "./run.js";
import { getState, setState } from "./state.js";

/** Jobs looked at per tick in each list (unstarted, then all open). */
export const SWEEP_LIMIT = 50;
/** Workflow calls in flight per tick. */
export const SWEEP_CONCURRENCY = 3;
/** The code a dead run settles with (errored, terminated, or complete with the job still open). */
export const RUN_DEAD: ProvisionErrorCode = "run_dead";

// Grace and keys (C5, @oa/shared/provisioning/state):
// - JOB_START_GRACE_MS: a queued job with no instance this old is started
//   by the sweep, so it never races the API's own Workflow.create.
// - JOB_TERMINATED_GRACE_MS: an errored or terminated instance is settled
//   only this long after the sweep first saw it so (sweepTerminatedKey):
//   R25 cancel terminates the instance and then settles the job itself
//   (code canceled, its own cleanup), so a sweep landing in between must not
//   settle it first. The marker is removed once the job is no longer open.
// - SWEEP_CURSOR_KEY: the last jobs rowid the open-jobs list reached; the
//   next tick resumes after it, and 0 starts over.
// First sight only: a later tick never moves it.
const SEEN =
  "INSERT INTO platform_state (key, value, updated_at) VALUES (?1, ?2, ?2) ON CONFLICT (key) DO NOTHING";
// Markers of jobs no longer open (settled by the sweep, a cancel or the run).
const SEEN_GC = `DELETE FROM platform_state WHERE substr(key, 1, ${SWEEP_TERMINATED_PREFIX.length}) = '${SWEEP_TERMINATED_PREFIX}' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = substr(platform_state.key, ${SWEEP_TERMINATED_PREFIX.length + 1}) AND j.status IN ('queued', 'running'))`;

const COLS =
  "rowid AS rid, id, kind, workflow, install_id, signup_id, status, created_at FROM jobs";
// A self-serve create the queue consumer has not admitted yet (design v7 7
// step 1: the daily cap) is the consumer's, never the sweep's to start.
const NOT_UNADMITTED =
  "NOT EXISTS (SELECT 1 FROM signups s WHERE s.job_id = jobs.id AND s.status IN ('pending', 'waiting_cap'))";
// Queued past the start grace, oldest first: its own list, so open jobs
// with long runs or retries never crowd out a create the API failed to start.
const UNSTARTED = `SELECT ${COLS} WHERE status = 'queued' AND workflow <> 'none' AND created_at <= ?1 AND ${NOT_UNADMITTED} ORDER BY created_at, id LIMIT ?2`;
// Every other open job, in rowid order from the cursor (?3), so live runs
// that rarely change never keep a dead run out of the list. The two lists
// never overlap.
const OPEN_JOBS = `SELECT ${COLS} WHERE status IN ('queued', 'running') AND workflow <> 'none' AND NOT (status = 'queued' AND created_at <= ?1) AND ${NOT_UNADMITTED} AND rowid > ?3 ORDER BY rowid LIMIT ?2`;

interface OpenJob {
  rid: number;
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

/** Dead only once JOB_TERMINATED_GRACE_MS has passed since first sight. */
const DEAD_AFTER_GRACE = new Set<WorkflowInstanceStatus["status"]>([
  "errored",
  "terminated",
]);

// The job if still open, with its stored code (null when none).
const STILL_OPEN =
  "SELECT error_code FROM jobs WHERE id = ?1 AND status IN ('queued', 'running')";
const stillOpen = (db: D1Database, id: string) =>
  d1(
    db
      .prepare(STILL_OPEN)
      .bind(id)
      .first<{ error_code: ProvisionErrorCode | null }>(),
  );

// The cleanup goes in only if its parent (?5, the insert's parent job id)
// ends up failed with the code this settle call writes (C5 settledWith):
// run_dead, or the code the open job already held, which settleFailed keeps
// (a cancel that stored canceled and died before its settle and cleanup).
// A job settled elsewhere is not settled here, so no cleanup from the sweep.
// INSERT OR IGNORE: jobs_one_active (a cleanup already open, e.g. that
// cancel's own) and cleanup-<jobId> (an earlier tick's) skip the row
// instead of failing the settle's batch.
const settledAs = (code: ProvisionErrorCode): JobGuard => ({
  sql: settledWith("?5", code),
  params: [],
  orIgnore: true,
});

/** What one open job needs: start it, settle it, or nothing. */
async function look(
  db: D1Database,
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
    return j.created_at <= now - JOB_START_GRACE_MS ? "start" : "alive";
  }
  if (DEAD_AFTER_GRACE.has(status)) {
    const key = sweepTerminatedKey(j.id);
    await d1(db.prepare(SEEN).bind(key, now).run());
    const seen = await d1(getState(db, key));
    return seen !== null && seen <= now - JOB_TERMINATED_GRACE_MS
      ? "dead"
      : "alive";
  }
  return status === "complete" ? "dead" : "alive";
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
  const cursor = (await d1(getState(db, SWEEP_CURSOR_KEY))) ?? 0;
  const [unstarted, open] = await d1(
    db.batch<OpenJob>([
      db.prepare(UNSTARTED).bind(now - JOB_START_GRACE_MS, SWEEP_LIMIT),
      db.prepare(OPEN_JOBS).bind(now - JOB_START_GRACE_MS, SWEEP_LIMIT, cursor),
    ]),
  );
  // A full page resumes after its last row; a short one starts over.
  const page = open?.results ?? [];
  const last = page.at(-1)?.rid;
  await d1(
    setState(
      db,
      SWEEP_CURSOR_KEY,
      page.length === SWEEP_LIMIT && typeof last === "number" ? last : 0,
      now,
    ),
  );
  // Best effort: a failed clean-up only leaves markers for the next tick.
  await db
    .prepare(SEEN_GC)
    .run()
    .catch(() => console.error("provapi sweep gc_failed db_error"));
  const todo = [...(unstarted?.results ?? []), ...(open?.results ?? [])];
  const one = async (j: OpenJob) => {
    const wf = flows[j.workflow];
    if (!wf) return;
    let step = "status";
    try {
      const what = await look(db, wf, j, now);
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
      const openRow = await stillOpen(db, j.id);
      if (openRow === null) return;
      // A dead cleanup is settled only, never given another cleanup.
      const cleanup: SystemJob | null =
        j.kind === "cleanup"
          ? null
          : {
              kind: "cleanup",
              installId: j.install_id,
              signupId: j.signup_id,
              parentJobId: j.id,
              requestId: cleanupRequestId(j.id),
              args: { parentJobId: j.id },
            };
      // The cleanup insert rides in the settle's own D1 batch (opts.extra,
      // design v7 3.6), so a failure, an evicted tick or another job opening
      // in between never leaves a failed job without its cleanup.
      const extra = cleanup
        ? [
            await systemJobStatement(
              db,
              cleanup,
              now,
              settledAs(openRow.error_code ?? RUN_DEAD),
            ),
          ]
        : [];
      const r = await settleFailed(db, j.id, RUN_DEAD, { extra });
      if (r.settled) {
        console.warn("provapi sweep settled", j.id, RUN_DEAD);
        await db
          .prepare("DELETE FROM platform_state WHERE key = ?1")
          .bind(sweepTerminatedKey(j.id))
          .run()
          .catch(() => {});
      }
      if (cleanup === null) return;
      step = "cleanup";
      const row = (r.extra[0] as D1Result<{ id?: unknown }> | undefined)
        ?.results?.[0];
      // No id: not inserted (settled elsewhere, a cleanup already open
      // on the install, or an overlapping tick's cleanup-<jobId>). Only a
      // row this batch inserted is started.
      const id = typeof row?.id === "string" ? row.id : null;
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
