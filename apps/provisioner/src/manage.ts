// ManageInstall (design v7 5.4-5.7): every job kind but create and retry
// (upgrade, rollback, suspend, resume, delete, restore, purge, discard,
// release_lease, cleanup, redline_creds), one instance per job. Instance id =
// job id; params are exactly { jobId } (3.6). Each kind's steps are
// JOB_STEPS[kind], all starting with the 2.5 recheck. The step bodies are
// W3's: typed stubs until then.
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
import type { WorkflowEnv } from "./workflow.js";

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
    const params = WorkflowParamsSchema.safeParse(event.payload);
    if (!params.success) throw new NonRetryableError("internal");
    const { jobId } = params.data;
    try {
      const job = await step.do("recheck", () => this.recheck(jobId));
      await this.operate(job, step);
    } catch (e) {
      await step.do("fail", () => this.fail(jobId));
      throw e;
    }
  }

  /** The 2.5 rechecks: state and the kind's transition (TRANSITIONS). */
  protected async recheck(jobId: string): Promise<ManageJob> {
    void jobId;
    throw notBuilt("recheck");
  }

  /** The kind's remaining JOB_STEPS, each its own step.do. */
  protected async operate(job: ManageJob, step: WorkflowStep): Promise<void> {
    void job;
    void step;
    throw notBuilt("operate");
  }

  /** settleFailed, and the kind's compensation (5.4-5.7). */
  protected async fail(jobId: string): Promise<{ failed: boolean }> {
    void jobId;
    throw notBuilt("fail");
  }
}
