// ProvisionInstall (design v7 5.2): one create or retry job becomes one
// hosted install and at most one welcome email. Instance id = job id; params
// are exactly { jobId } (3.6), everything else is read from D1, and every D1
// row is a request, never a fact (2.5). The owner's email is read from
// signup_secret inside the steps that need it and never leaves them: no step
// output, error, log line or param carries it. The owner token label is
// ss-<signupId>, stable across create and retry jobs.
//
// Steps, in order (JOB_STEPS.create): admit, recheck, reserve, release_gate,
// create (provision reports upload, verify_clean, health, route,
// enable_signin and active through onStep), reachable, notify, done; a step
// that fails for good ends in `fail`. The step bodies are W3's: each is a
// typed stub until then.
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { BundleVariant, WfpProvisioner } from "@oa/provision";
import {
  type WorkflowParams,
  WorkflowParamsSchema,
} from "@oa/shared/provisioning";
import {
  type ProvisionerEnv,
  provisionerFor,
  transient,
} from "./provisioner.js";
import { notBuilt } from "./stub.js";

export interface WorkflowEnv extends ProvisionerEnv {
  PLATFORM_DB: D1Database;
  WELCOME_EMAIL: SendEmail;
  /** The install's script before any HOSTS mapping (5.2 f, directFetch). */
  DISPATCHER: DispatchNamespace;
  /** The tier a self-serve row must carry (2.5 recheck). */
  SELF_SERVE_TIER: string;
  WELCOME_FROM: string;
}

/** The rechecked create job (2.5): what the later steps read. */
export type CreateJob = {
  jobId: string;
  kind: "create" | "retry";
  signupId: string;
  source: "admin" | "self-serve";
  slug: string;
  /** Set once reserve has run (a rerun reads it back). */
  installId: string | null;
  /** The strict-schema install vars (5.3). */
  vars: Record<string, string>;
  /** args.version, or null for the latest installable. */
  version: string | null;
  testHooks: boolean;
  sendWelcome: boolean;
};

/** release_gate's output: the release create runs (5.2 step 4). */
export type ReleaseGate = { version: string; bundle: BundleVariant };

/** 4 attempts, 1 minute, exponential; an attempt may not pass 45 minutes. */
const CREATE_STEP = {
  retries: { limit: 4, delay: "1 minute", backoff: "exponential" },
  timeout: "45 minutes",
} as const;

const SECRET_EMAIL =
  "SELECT owner_email AS email FROM signup_secret WHERE signup_id = ?";

export class ProvisionInstall extends WorkflowEntrypoint<
  WorkflowEnv,
  WorkflowParams
> {
  // The runtime's network and clock; the tests' subclass runs on fake-cf's.
  protected fetch: typeof fetch = (input, init) => fetch(input, init);
  protected now: () => number = () => Date.now();
  protected sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

  async run(
    event: Readonly<WorkflowEvent<WorkflowParams>>,
    step: WorkflowStep,
  ): Promise<void> {
    const params = WorkflowParamsSchema.safeParse(event.payload);
    if (!params.success) throw new NonRetryableError("internal");
    const { jobId } = params.data;
    try {
      await step.do("admit", () => this.admit(jobId));
      const job = await step.do("recheck", () => this.recheck(jobId));
      const { installId } = await step.do("reserve", () => this.reserve(job));
      const gate = await step.do("release_gate", () => this.releaseGate(job));
      const { appHost } = await step.do("create", CREATE_STEP, () =>
        this.create(job, installId, gate),
      );
      await step.do("reachable", () => this.reachable(appHost));
      await step.do("notify", () => this.notify(job, appHost));
      await step.do("done", () => this.done(job, installId));
    } catch (e) {
      await step.do("fail", () => this.fail(jobId));
      throw e;
    }
  }

  protected get db(): D1Database {
    return this.env.PLATFORM_DB;
  }

  /** The owner's email (the API wrote it); null once done has deleted it. */
  protected async ownerEmail(signupId: string): Promise<string | null> {
    const r = await transient(
      this.db.prepare(SECRET_EMAIL).bind(signupId).first<{ email: string }>(),
    );
    return r?.email ?? null;
  }

  /** The job's WfpProvisioner, its owner token labelled `ss-<signupId>`. */
  protected provisioner(signupId: string): Promise<WfpProvisioner> {
    return provisionerFor(this.env, `ss-${signupId}`, {
      fetch: this.fetch,
      now: this.now,
      sleep: this.sleep,
    });
  }

  /** Admin and OIDC: a no-op; self-serve: the consumer's admit() ran. */
  protected async admit(jobId: string): Promise<{ admitted: true }> {
    void jobId;
    throw notBuilt("admit");
  }

  /** The 2.5 rechecks: state, transition, strict vars, self-serve tier. */
  protected async recheck(jobId: string): Promise<CreateJob> {
    void jobId;
    throw notBuilt("recheck");
  }

  /** install_id = COALESCE(install_id, ?), signups.status creating. */
  protected async reserve(job: CreateJob): Promise<{ installId: string }> {
    void job;
    throw notBuilt("reserve");
  }

  /** The release record, floor and variant; no Cloudflare writes. */
  protected async releaseGate(job: CreateJob): Promise<ReleaseGate> {
    void job;
    throw notBuilt("release_gate");
  }

  /** Sweep, then WfpProvisioner.create with the 5.3 inputs. */
  protected async create(
    job: CreateJob,
    installId: string,
    gate: ReleaseGate,
  ): Promise<{ appHost: string }> {
    void job;
    void installId;
    void gate;
    throw notBuilt("create");
  }

  /** Public /healthz through dispatch; records, never fails the job. */
  protected async reachable(appHost: string): Promise<{ ok: boolean }> {
    void appHost;
    throw notBuilt("reachable");
  }

  /** At most one welcome, only when send_welcome = 1 (claim before send). */
  protected async notify(
    job: CreateJob,
    appHost: string,
  ): Promise<{ sent: boolean }> {
    void job;
    void appHost;
    throw notBuilt("notify");
  }

  /** Sweep, delete signup_secret, signups ready, job done, audit. */
  protected async done(
    job: CreateJob,
    installId: string,
  ): Promise<{ ready: true }> {
    void job;
    void installId;
    throw notBuilt("done");
  }

  /** settleFailed (and for prod_dirty the snapshot and purge job), sweep. */
  protected async fail(jobId: string): Promise<{ failed: boolean }> {
    void jobId;
    throw notBuilt("fail");
  }

  /** Revokes the install's active ss-<signupId> owner tokens. */
  protected async sweep(
    signupId: string,
    installId: string,
  ): Promise<{ revoked: number }> {
    void signupId;
    void installId;
    throw notBuilt("sweep");
  }
}
