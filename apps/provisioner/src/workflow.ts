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
//
// The class is an exported entrypoint, so any Worker bound to it with this
// entrypoint can call every prototype method (TS `protected` is not enforced
// at runtime). Its prototype is exactly constructor and run (2.6); every
// helper is a module function taking a CreateCtx.
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
  type ProvisionerIo,
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
export const CREATE_STEP = {
  retries: { limit: 4, delay: "1 minute", backoff: "exponential" },
  timeout: "45 minutes",
} as const;

/** 3 attempts, 30 seconds, exponential (5.2 step 4). */
export const RELEASE_GATE_STEP = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
} as const;

/** 2 retries, 10 seconds, exponential (5.2 step 7). */
export const REACHABLE_STEP = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
} as const;

const SECRET_EMAIL =
  "SELECT owner_email AS email FROM signup_secret WHERE signup_id = ?";

/** What every step function reads: the env and the network and clock. */
export type CreateCtx = { env: WorkflowEnv; io: ProvisionerIo };

/** The runtime's network and clock; the tests run on fake-cf's. */
export const RUNTIME_IO: ProvisionerIo = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export class ProvisionInstall extends WorkflowEntrypoint<
  WorkflowEnv,
  WorkflowParams
> {
  async run(
    event: Readonly<WorkflowEvent<WorkflowParams>>,
    step: WorkflowStep,
  ): Promise<void> {
    return runCreate({ env: this.env, io: RUNTIME_IO }, event, step);
  }
}

/** ProvisionInstall.run, on any CreateCtx. */
export async function runCreate(
  ctx: CreateCtx,
  event: Readonly<WorkflowEvent<WorkflowParams>>,
  step: WorkflowStep,
): Promise<void> {
  const params = WorkflowParamsSchema.safeParse(event.payload);
  if (!params.success) throw new NonRetryableError("internal");
  const { jobId } = params.data;
  try {
    await step.do("admit", () => admit(ctx, jobId));
    const job = await step.do("recheck", () => recheck(ctx, jobId));
    const { installId } = await step.do("reserve", () => reserve(ctx, job));
    const gate = await step.do("release_gate", RELEASE_GATE_STEP, () =>
      releaseGate(ctx, job),
    );
    const { appHost } = await step.do("create", CREATE_STEP, () =>
      create(ctx, job, installId, gate),
    );
    await step.do("reachable", REACHABLE_STEP, () => reachable(ctx, appHost));
    await step.do("notify", () => notify(ctx, job, appHost));
    await step.do("done", () => done(ctx, job, installId));
  } catch (e) {
    await step.do("fail", () => fail(ctx, jobId));
    throw e;
  }
}

/** The owner's email (the API wrote it); null once done has deleted it. */
export async function ownerEmail(
  ctx: CreateCtx,
  signupId: string,
): Promise<string | null> {
  const r = await transient(
    ctx.env.PLATFORM_DB.prepare(SECRET_EMAIL)
      .bind(signupId)
      .first<{ email: string }>(),
  );
  return r?.email ?? null;
}

/** The job's WfpProvisioner, its owner token labelled `ss-<signupId>`. */
export function provisioner(
  ctx: CreateCtx,
  signupId: string,
): Promise<WfpProvisioner> {
  return provisionerFor(ctx.env, `ss-${signupId}`, ctx.io);
}

/** Admin and OIDC: a no-op; self-serve: the consumer's admit() ran. */
async function admit(
  ctx: CreateCtx,
  jobId: string,
): Promise<{ admitted: true }> {
  void ctx;
  void jobId;
  throw notBuilt("admit");
}

/** The 2.5 rechecks: state, transition, strict vars, self-serve tier. */
async function recheck(ctx: CreateCtx, jobId: string): Promise<CreateJob> {
  void ctx;
  void jobId;
  throw notBuilt("recheck");
}

/** install_id = COALESCE(install_id, ?), signups.status creating. */
async function reserve(
  ctx: CreateCtx,
  job: CreateJob,
): Promise<{ installId: string }> {
  void ctx;
  void job;
  throw notBuilt("reserve");
}

/** The release record, floor and variant; no Cloudflare writes. */
async function releaseGate(
  ctx: CreateCtx,
  job: CreateJob,
): Promise<ReleaseGate> {
  void ctx;
  void job;
  throw notBuilt("release_gate");
}

/** Sweep, then WfpProvisioner.create with the 5.3 inputs. */
async function create(
  ctx: CreateCtx,
  job: CreateJob,
  installId: string,
  gate: ReleaseGate,
): Promise<{ appHost: string }> {
  void ctx;
  void job;
  void installId;
  void gate;
  throw notBuilt("create");
}

/** Public /healthz through dispatch; records, never fails the job. */
async function reachable(
  ctx: CreateCtx,
  appHost: string,
): Promise<{ ok: boolean }> {
  void ctx;
  void appHost;
  throw notBuilt("reachable");
}

/** At most one welcome, only when send_welcome = 1 (claim before send). */
async function notify(
  ctx: CreateCtx,
  job: CreateJob,
  appHost: string,
): Promise<{ sent: boolean }> {
  void ctx;
  void job;
  void appHost;
  throw notBuilt("notify");
}

/** Sweep, delete signup_secret, signups ready, job done, audit. */
async function done(
  ctx: CreateCtx,
  job: CreateJob,
  installId: string,
): Promise<{ ready: true }> {
  void ctx;
  void job;
  void installId;
  throw notBuilt("done");
}

/** settleFailed (and for prod_dirty the snapshot and purge job), sweep. */
async function fail(
  ctx: CreateCtx,
  jobId: string,
): Promise<{ failed: boolean }> {
  void ctx;
  void jobId;
  throw notBuilt("fail");
}

/** Revokes the install's active ss-<signupId> owner tokens. */
export async function sweep(
  ctx: CreateCtx,
  signupId: string,
  installId: string,
): Promise<{ revoked: number }> {
  void ctx;
  void signupId;
  void installId;
  throw notBuilt("sweep");
}
