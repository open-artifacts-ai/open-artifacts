// ManageInstall (design v7 5.4-5.7): every job kind but create and retry
// (upgrade, rollback, suspend, resume, delete, restore, purge, discard,
// release_lease, cleanup, redline_creds), one instance per job. Instance id =
// job id; params are exactly { jobId } (3.6). Each kind's steps are
// JOB_STEPS[kind]: every kind but cleanup starts with the 2.5 recheck, and
// the kind is read from D1, so operate picks the steps. The step bodies are
// W3's: typed stubs until then. As in workflow.ts, the class's prototype is
// exactly constructor and run (2.6); helpers are module functions.
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  type JobKind,
  type WorkflowParams,
  WorkflowParamsSchema,
} from "@oa/shared/provisioning";
import { notBuilt } from "./stub.js";
import { type CreateCtx, RUNTIME_IO, type WorkflowEnv } from "./workflow.js";

export type ManageEnv = WorkflowEnv;

/** The rechecked job: its kind, install and args (never an email). */
export type ManageJob = {
  jobId: string;
  kind: Exclude<JobKind, "create" | "retry">;
  installId: string;
  args: { version?: string; from?: string; to?: string; reason?: string };
};

export class ManageInstall extends WorkflowEntrypoint<
  ManageEnv,
  WorkflowParams
> {
  async run(
    event: Readonly<WorkflowEvent<WorkflowParams>>,
    step: WorkflowStep,
  ): Promise<void> {
    return runManage({ env: this.env, io: RUNTIME_IO }, event, step);
  }
}

/** ManageInstall.run, on any CreateCtx. */
export async function runManage(
  ctx: CreateCtx,
  event: Readonly<WorkflowEvent<WorkflowParams>>,
  step: WorkflowStep,
): Promise<void> {
  const params = WorkflowParamsSchema.safeParse(event.payload);
  if (!params.success) throw new NonRetryableError("internal");
  const { jobId } = params.data;
  try {
    await operate(ctx, jobId, step);
  } catch (e) {
    await step.do("fail", () => fail(ctx, jobId));
    throw e;
  }
}

/**
 * Reads the job's kind, then runs JOB_STEPS[kind], each its own step.do:
 * the recheck (state and the kind's TRANSITIONS) first, except for cleanup.
 */
async function operate(
  ctx: CreateCtx,
  jobId: string,
  step: WorkflowStep,
): Promise<void> {
  void ctx;
  void jobId;
  void step;
  throw notBuilt("operate");
}

/** settleFailed, and the kind's compensation (5.4-5.7). */
async function fail(
  ctx: CreateCtx,
  jobId: string,
): Promise<{ failed: boolean }> {
  void ctx;
  void jobId;
  throw notBuilt("fail");
}
