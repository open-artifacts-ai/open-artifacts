// Job sweep (design v7 5.8): start open jobs whose Workflow instance never
// started, and settle jobs whose run is dead, each followed by one cleanup
// job (lease, owner tokens, signups) on ManageInstall.
import {
  type ProvisionErrorCode,
  settleFailed as realSettleFailed,
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
  startJob,
  wfCall,
} from "./jobs.js";
import { dutyCategory } from "./run.js";

/** Open jobs looked at per tick, oldest change first. */
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

const OPEN_JOBS =
  "SELECT id, kind, workflow, install_id, signup_id, status, created_at FROM jobs WHERE status IN ('queued', 'running') AND workflow <> 'none' ORDER BY updated_at, id LIMIT ?1";

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
  /**
   * TODO(contract): injected until W3 builds settleFailed (it throws), and
   * because it runs its own batch: settling and inserting the cleanup are
   * two writes, not the design's one fail batch.
   */
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
  const { results } = await d1(
    db.prepare(OPEN_JOBS).bind(SWEEP_LIMIT).all<OpenJob>(),
  );
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
      // TODO(contract): settleFailed does not say whether it settled.
      if (!(await stillOpen(db, j.id))) return;
      await settleFailed(db, j.id, DEAD_RUN_CODE);
      if (await stillOpen(db, j.id)) return;
      console.warn("provapi sweep settled", j.id, DEAD_RUN_CODE);
      // A dead cleanup is settled only, never given another cleanup.
      if (j.kind === "cleanup") return;
      step = "cleanup";
      const id = await insertSystemJob(
        db,
        {
          kind: "cleanup",
          installId: j.install_id,
          signupId: j.signup_id,
          parentJobId: j.id,
          requestId: `cleanup-${j.id}`,
        },
        now,
      );
      // null: an overlapping tick (or another open job) got there first.
      if (id === null) return;
      console.log("provapi sweep cleanup", id, j.id);
      // A failed start leaves it queued; the next sweep starts it.
      await startJob(manage, id);
    } catch (e) {
      console.error("provapi sweep", `${step}_failed`, dutyCategory(e), j.id);
    }
  };
  await lanes(results, SWEEP_CONCURRENCY, one);
}
