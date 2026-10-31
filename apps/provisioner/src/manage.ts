// ManageInstall (design v7 5.4-5.7): every job kind but create and retry
// (upgrade, rollback, suspend, resume, delete, restore, purge, discard,
// release_lease, cleanup, redline_creds), one instance per job. Instance id =
// job id; params are exactly { jobId } (3.6). Each kind's steps are
// JOB_STEPS[kind]: every kind but cleanup starts with the 2.5 recheck, and
// the kind is read from D1 (step `load`), so operate picks the steps. As in
// workflow.ts, the class's prototype is exactly constructor and run (2.6);
// helpers are module functions.
//
// Write order (5.5): exposure goes down HOSTS first (pause, then the D1
// record) and up D1 first (the record, then unpause). Each step checks
// first, so a replay of any step changes nothing: upgrade and rollback
// compare installs.version with the job's fixed {from, to}.
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  bucketVersions,
  ProvisionRefused,
  ProvisionRetry,
  type R2CatalogBucket,
  r2BindingReleaseReader,
  releaseGate,
  settleFailedStatements,
  type UpgradeResult,
} from "@oa/provision";
import {
  type JobKind,
  type WorkflowParams,
  WorkflowParamsSchema,
} from "@oa/shared/provisioning";
import { codeOf } from "./errors.js";
import {
  installRow,
  liveMode,
  modeStatement,
  provisionerWith,
  reconcile,
  renderOptions,
  storedVars,
  sweepTokens,
} from "./ops.js";
import { deployEnv, transient } from "./provisioner.js";
import {
  checkJob,
  checkOidcScope,
  checkTransition,
  readStatus,
  refused,
  type StatusRow,
} from "./recheck.js";
import { redlineCreds } from "./redline.js";
import {
  argsOf,
  doneAuditStatement,
  doneStatement,
  failedAuditStatement,
  type JobRow,
  jobCode,
  jobStep,
  markStep,
  readJob,
} from "./steps.js";
import {
  type CreateCtx,
  RELEASE_GATE_STEP,
  RUNTIME_IO,
  type WorkflowEnv,
} from "./workflow.js";

export type ManageEnv = WorkflowEnv;
type ManageKind = Exclude<JobKind, "create" | "retry">;
const KINDS: readonly ManageKind[] = [
  "upgrade",
  "rollback",
  "suspend",
  "resume",
  "delete",
  "restore",
  "purge",
  "discard",
  "release_lease",
  "cleanup",
  "redline_creds",
];

/** The rechecked job: its kind, install and args (never an email). */
export type ManageJob = {
  jobId: string;
  kind: ManageKind;
  installId: string;
  slug: string | null;
  appHost: string | null;
  testHooks: boolean;
  /** The job's signup (a create's); its owner token label is ss-<id>. */
  signupId: string | null;
  /** The sign-in copy stays disabled on rewrites (5.4 registryDisabled). */
  registryDisabled: boolean;
  suspended: boolean;
  args: { from?: string; to?: string; reason?: string; force?: boolean };
  /** upgrade, rollback: the install is already on `to`; nothing to do. */
  already?: boolean;
  /** purge: the skip reason for the directory revoke, if any. */
  skipDirectoryRevoke?: string;
};

/**
 * upgrade and rollback: 2 retries, 2 minutes; an attempt up to 45 minutes
 * (3.6 says "2 attempts"; read as retries, like 5.2's Retries column).
 */
export const MANAGE_UPLOAD_STEP = {
  retries: { limit: 2, delay: "2 minutes", backoff: "exponential" },
  timeout: "45 minutes",
} as const;
/** purge: revoke_pending and lease refusals retry with bounded backoff (5.6). */
export const PURGE_STEP = {
  retries: { limit: 6, delay: "2 minutes", backoff: "exponential" },
  timeout: "45 minutes",
} as const;
/** suspend, resume, delete, restore, release_lease, cleanup: a lease may be held. */
export const LEASED_STEP = {
  retries: { limit: 5, delay: "1 minute", backoff: "exponential" },
} as const;

/** Soft delete grace (5.6). */
export const GRACE_MS = 7 * 86_400_000;
/** The fixed, audited skip reason for a purge of a never-routed create (5.2). */
export const NEVER_ROUTED = "never_routed";

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

/**
 * What one run of a job knows beyond its step results: the lease its
 * upgrade or rollback claimed, and whether what serves is dirty. Never in
 * jobs.args, which stays the request {version, from, to, reason} (8.3).
 * Neither has to survive the isolate: a replayed render reads the job's
 * own hosted_audit rows (renderOutcome), and fail stores the lease it
 * judged this job's in its step result, which fail_release compares.
 */
export type RunState = {
  claimedLease?: string | null;
  dirty: boolean;
};

/** ManageInstall.run, on any CreateCtx. */
export async function runManage(
  ctx: CreateCtx,
  event: Readonly<WorkflowEvent<WorkflowParams>>,
  step: WorkflowStep,
): Promise<void> {
  const params = WorkflowParamsSchema.safeParse(event.payload);
  if (!params.success) throw new NonRetryableError("internal");
  const { jobId } = params.data;
  const run: RunState = { dirty: false };
  try {
    await operate(ctx, jobId, step, run);
  } catch (e) {
    const f = await step.do("fail", async () => {
      try {
        return await fail(ctx, jobId, run);
      } catch (x) {
        throw new Error(codeOf(x));
      }
    });
    // An upgrade or rollback left upgrading under its lease: wait it out,
    // then release it without force (5.4 fail).
    if (f.leaseUntil !== null) {
      if (f.leaseUntil >= ctx.io.now())
        await step.sleepUntil("lease_expiry", new Date(f.leaseUntil + 1));
      await step.do("fail_release", async () => {
        try {
          return await releaseExpired(ctx, jobId, f.lease);
        } catch (x) {
          throw new Error(codeOf(x));
        }
      });
    }
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
  run: RunState,
): Promise<void> {
  const { kind } = await step.do("load", async () => {
    const job = await readJob(ctx, jobId);
    if (!job || !(KINDS as readonly string[]).includes(job.kind))
      throw new NonRetryableError("invalid_state");
    return { kind: job.kind as ManageKind };
  });
  const s = <T>(
    name: string,
    config: Parameters<typeof jobStep>[4],
    fn: () => Promise<T>,
  ) => jobStep(ctx, step, jobId, name, config, fn);
  if (kind === "cleanup") return cleanup(ctx, jobId, step);
  const job = await s("recheck", undefined, () => recheck(ctx, jobId));
  const p = (j: ManageJob) =>
    provisionerWith(ctx, labelOf(j), j.jobId, {
      registryDisabled: j.registryDisabled,
    });
  switch (job.kind) {
    case "upgrade": {
      if (!job.already) {
        const g = await s("release_gate", RELEASE_GATE_STEP, () =>
          releaseGate({
            release: r2BindingReleaseReader(
              ctx.env.RELEASES as unknown as R2CatalogBucket,
              deployEnv(ctx.env.OA_ENV),
            ),
            env: deployEnv(ctx.env.OA_ENV),
            version: job.args.to as string,
            testHooks: job.testHooks,
            versions: () =>
              bucketVersions(ctx.env.RELEASES as unknown as R2CatalogBucket),
            above: job.args.from as string,
          }),
        );
        const u = await s("upload", MANAGE_UPLOAD_STEP, () =>
          render(ctx, job, "upgrade", g.version, run),
        );
        if (u.dirty) await pauseDirty(ctx, step, job, "upgrade", run);
      }
      break;
    }
    case "rollback":
      if (!job.already) {
        const u = await s("upload", MANAGE_UPLOAD_STEP, () =>
          render(ctx, job, "rollback", job.args.to as string, run),
        );
        if (u.dirty) await pauseDirty(ctx, step, job, "rollback", run);
      }
      break;
    case "suspend":
      await s("pause", LEASED_STEP, async () => {
        await (await p(job)).pause(job.installId, "paused", {
          kind: "suspend",
        });
        await transient(modeStatement(ctx, job.installId, "paused").run());
        return { mode: "paused" };
      });
      await s("record", undefined, () =>
        record(
          ctx,
          "UPDATE install_lifecycle SET suspended_at = COALESCE(suspended_at, ?2), suspend_reason = ?3, updated_at = ?2 WHERE install_id = ?1",
          job.installId,
          ctx.io.now(),
          job.args.reason ?? null,
        ),
      );
      break;
    case "resume":
      await s("record", undefined, () =>
        record(
          ctx,
          "UPDATE install_lifecycle SET suspended_at = NULL, suspend_reason = NULL, updated_at = ?2 WHERE install_id = ?1",
          job.installId,
          ctx.io.now(),
        ),
      );
      await s("unpause", LEASED_STEP, async () => {
        await (await p(job)).unpause(job.installId, { kind: "resume" });
        await transient(modeStatement(ctx, job.installId, "serving").run());
        return { mode: "serving" };
      });
      break;
    case "delete":
      await s("close", LEASED_STEP, async () => {
        await (await p(job)).pause(job.installId, "closed", { kind: "delete" });
        await transient(modeStatement(ctx, job.installId, "closed").run());
        return { mode: "closed" };
      });
      await s("record", undefined, () => {
        const now = ctx.io.now();
        return record(
          ctx,
          "UPDATE install_lifecycle SET deleted_at = COALESCE(deleted_at, ?2), purge_at = COALESCE(purge_at, ?3), updated_at = ?2 WHERE install_id = ?1",
          job.installId,
          now,
          now + GRACE_MS,
        );
      });
      break;
    case "restore":
      // Clearing purge_at first cancels the scheduled purge.
      await s("record", undefined, () =>
        record(
          ctx,
          "UPDATE install_lifecycle SET deleted_at = NULL, purge_at = NULL, updated_at = ?2 WHERE install_id = ?1",
          job.installId,
          ctx.io.now(),
        ),
      );
      await s("reopen", LEASED_STEP, async () => {
        const w = await p(job);
        const mode = job.suspended ? "paused" : "serving";
        if (mode === "paused")
          await w.pause(job.installId, "paused", { kind: "restore" });
        else await w.unpause(job.installId, { kind: "restore" });
        await transient(modeStatement(ctx, job.installId, mode).run());
        return { mode };
      });
      break;
    case "purge":
      await s("unroute", PURGE_STEP, async () => {
        const w = await p(job);
        await w.delete(job.installId, job.installId, {
          ...(job.skipDirectoryRevoke
            ? { skipDirectoryRevoke: job.skipDirectoryRevoke }
            : {}),
          // A settled revoke goes straight on to teardown.
          onPoll: (p) =>
            markStep(
              ctx,
              jobId,
              p.state === "done" || p.state === "skipped"
                ? "teardown"
                : "revoke_directory",
            ),
        });
        await markStep(ctx, jobId, "teardown");
        await transient(modeStatement(ctx, job.installId, "unmapped").run());
        return { state: "deleted" };
      });
      break;
    case "discard":
      await s("free", undefined, () => {
        const now = ctx.io.now();
        return record(
          ctx,
          "UPDATE install_lifecycle SET deleted_at = COALESCE(deleted_at, ?2), purge_at = COALESCE(purge_at, ?2), discarded_at = COALESCE(discarded_at, ?2), serving_mode = 'unmapped', updated_at = ?2 WHERE install_id = ?1",
          job.installId,
          now,
        );
      });
      break;
    case "release_lease":
      await s("release", undefined, async () => {
        const row = await installRow(ctx, job.installId);
        if (!row?.lease) return { released: false };
        const r = await (await p(job)).releaseLease(
          job.installId,
          job.installId,
          { force: job.args.force === true },
        );
        return { released: r.released };
      });
      break;
    case "redline_creds":
      await redlineCreds(ctx, step, jobId, job);
      break;
  }
  await s("done", undefined, () => finish(ctx, job));
}

/** The owner token label of a job: its signup's, else the job's own. */
const labelOf = (j: { signupId: string | null; jobId: string }) =>
  `ss-${j.signupId ?? j.jobId}`;

/** One lifecycle write; the step's output is the change count only. */
async function record(
  ctx: CreateCtx,
  sql: string,
  ...binds: unknown[]
): Promise<{ changed: number }> {
  const r = await transient(
    ctx.env.PLATFORM_DB.prepare(sql)
      .bind(...binds)
      .run(),
  );
  return { changed: r.meta.changes ?? 0 };
}

/**
 * upgrade or rollback with the CLI's derived options (5.4) and the outcome
 * mapping: ok is done; a dirty serving script is returned (the step result
 * carries it to pause_dirty, and on a replay too); a forward fix is
 * `upgrade_incomplete`; a rollback is `upgrade_rolled_back`. An earlier
 * render of this job (an attempt whose result was lost with its isolate)
 * is read back from its hosted_audit rows (renderOutcome) and mapped the
 * same way, never rendered again. recheck found the install off `to`, and
 * jobs_one_active keeps other jobs off it, so `to` serving with no
 * finished render on record is paused as dirty.
 */
async function render(
  ctx: CreateCtx,
  job: ManageJob,
  kind: "upgrade" | "rollback",
  to: string,
  run: RunState,
): Promise<{ version: string; dirty?: true }> {
  // An earlier attempt in this run found it dirty: never render again.
  if (run.dirty) return { version: to, dirty: true };
  const row = await installRow(ctx, job.installId);
  if (!row) throw refused("no installs row");
  const onTo = row.version === to && row.state === "active";
  const done = await renderOutcome(ctx, job, kind);
  if (done === "dirty") {
    run.dirty = true;
    return { version: to, dirty: true };
  }
  if (done === "clean" && onTo) return { version: to };
  if (done === "rolled_back") throw rolledBack(to, job.args.from as string);
  if (done === "incomplete") throw incomplete(kind, to);
  if (onTo) return { version: to, dirty: true };
  if (row.version !== job.args.from) throw refused("the version moved");
  const w = await renderOptions(ctx, {
    jobId: job.jobId,
    label: labelOf(job),
    installId: job.installId,
    appHost: row.app_host,
    vars: storedVars(row.vars),
    testHooks: row.test_hooks === 1,
    registryDisabled: job.registryDisabled,
    onClaim: (lease) => {
      run.claimedLease = lease;
    },
  });
  const r: UpgradeResult =
    kind === "upgrade"
      ? await w.upgrade(job.installId, to)
      : await w.rollback(job.installId);
  if (r.ok) return { version: r.to };
  if (r.prodDirty) {
    run.dirty = true;
    return { version: to, dirty: true };
  }
  if (kind === "upgrade" && r.rolledBack && !r.forwardFix)
    throw rolledBack(to, r.from);
  throw incomplete(kind, to);
}

const rolledBack = (to: string, from: string) =>
  new ProvisionRefused(
    `upgrade to ${to} failed and rolled back to ${from}`,
    "upgrade_rolled_back",
  );
const incomplete = (kind: string, to: string) =>
  new ProvisionRefused(
    `${kind} to ${to} did not finish; a forward fix is needed`,
    "upgrade_incomplete",
  );

/** The rows that start an upload, and those that end one. */
const RENDER_ROWS = [
  "upgrade.start",
  "rollback.start",
  "verify_clean.refused",
  "upgrade.done",
  "rollback.done",
  "upgrade.forward_fix",
  "upgrade.incomplete",
  "rollback.incomplete",
  "rollback.unhealthy",
] as const;

/**
 * How this job's last finished render ended, from WfpProvisioner's own
 * hosted_audit rows (written as job:<jobId>, 4.9, each before the operation
 * returns): durable where the run's memory is not. The last upload is the
 * last upgrade.start or rollback.start (an upgrade's auto-rollback comes
 * after its upgrade.start). A verify_clean.refused after it is dirty
 * (what serves failed the check); else a .done is clean, and the other end
 * rows are incomplete. An upgrade whose last upload is its auto-rollback is
 * rolled_back unless dirty. null: no render finished (none ran, or one
 * aborted before its end row, which a retry renders again).
 */
async function renderOutcome(
  ctx: CreateCtx,
  job: ManageJob,
  kind: "upgrade" | "rollback",
): Promise<"clean" | "dirty" | "rolled_back" | "incomplete" | null> {
  const r = await transient(
    ctx.env.PLATFORM_DB.prepare(
      `SELECT action FROM hosted_audit WHERE install_id = ?1 AND actor = ?2 AND action IN (${RENDER_ROWS.map((a) => `'${a}'`).join(", ")}) ORDER BY id`,
    )
      .bind(job.installId, `job:${job.jobId}`)
      .all<{ action: string }>(),
  );
  const rows = r.results.map((x) => x.action);
  const i = Math.max(
    rows.lastIndexOf("upgrade.start"),
    rows.lastIndexOf("rollback.start"),
  );
  if (i < 0) return null;
  const after = rows.slice(i + 1);
  if (after.includes("verify_clean.refused")) return "dirty";
  const ended = after.some((a) => !a.endsWith(".start"));
  if (!ended) return null;
  if (kind === "upgrade" && rows[i] === "rollback.start") return "rolled_back";
  return after.some((a) => a.endsWith(".done")) ? "clean" : "incomplete";
}

/**
 * A dirty serving script, paused (its own step, so a retry only pauses
 * again), then `prod_dirty`. jobs.step stays upload (JOB_STEPS).
 */
async function pauseDirty(
  ctx: CreateCtx,
  step: WorkflowStep,
  job: ManageJob,
  kind: "upgrade" | "rollback",
  run: RunState,
): Promise<never> {
  // Set before the pause: a pause that fails still fails prod_dirty.
  run.dirty = true;
  await jobStep(
    ctx,
    step,
    job.jobId,
    "pause_dirty",
    LEASED_STEP,
    async () => {
      // Lowering exposure only warns near expiry (5.5, 5.7): the pause runs
      // as a suspend whatever the parent kind, so an upgrade's "refuse"
      // never keeps the dirty script serving.
      await (await provisionerWith(ctx, labelOf(job), job.jobId)).pause(
        job.installId,
        "paused",
        { kind: "suspend" },
      );
      await transient(modeStatement(ctx, job.installId, "paused").run());
      throw new ProvisionRefused(
        `${kind} left a script that fails verify_clean; paused`,
        "prod_dirty",
      );
    },
    undefined,
    "upload",
  );
  throw new NonRetryableError("prod_dirty");
}

/**
 * The job done, audited; only while it is open. The audit comes first, on
 * the job still open, so it follows only the batch that marks it done (not
 * a cancel that won the race, nor a replay).
 */
async function finish(
  ctx: CreateCtx,
  job: { jobId: string; kind: string; installId: string },
): Promise<{ done: true }> {
  await transient(
    ctx.env.PLATFORM_DB.batch([
      doneAuditStatement(ctx, job),
      doneStatement(ctx, job.jobId),
    ]),
  );
  return { done: true };
}

const STRING = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;

/** The 2.5 rechecks for a ManageInstall job (purge preconditions included). */
async function recheck(ctx: CreateCtx, jobId: string): Promise<ManageJob> {
  const env = deployEnv(ctx.env.OA_ENV);
  const job = checkJob(await readJob(ctx, jobId), "manage_install", KINDS);
  const kind = job.kind as ManageKind;
  const st = await readStatus(ctx, job.install_id);
  if (!st) throw refused("no lifecycle row");
  const row = await installRow(ctx, job.install_id);
  const args = argsOf(job);
  // 2.5: a user (the API's self-serve owner) acts on a self-serve install only.
  if (job.actor_kind === "user" && st.source !== "self-serve")
    throw refused("a user acts only on a self-serve install");
  await checkKind(ctx, job, kind, st);
  const out: ManageJob = {
    jobId,
    kind,
    installId: job.install_id,
    slug: row?.slug ?? st.slug,
    appHost: row?.app_host ?? null,
    testHooks: (row?.test_hooks ?? st.test_hooks) === 1,
    signupId: st.signup_id,
    registryDisabled: st.suspended_at !== null || st.deleted_at !== null,
    suspended: st.suspended_at !== null,
    args: {},
  };
  checkOidcScope(job, env, out);
  const now = ctx.io.now();
  switch (kind) {
    case "upgrade":
    case "rollback": {
      if (!STRING(args.from, 20) || !STRING(args.to, 20))
        throw refused("the job has no from and to");
      if (!row) throw refused("no installs row");
      out.args = { from: args.from, to: args.to };
      if (
        kind === "rollback" &&
        row.previous_version !== args.to &&
        row.version !== args.to
      )
        throw refused("to is not the previous version");
      if (row.version === args.to && row.state === "active") out.already = true;
      else if (row.version !== args.from) throw refused("the version moved");
      break;
    }
    case "suspend":
      if (!STRING(args.reason, 200)) throw refused("no reason");
      out.args = { reason: args.reason };
      break;
    case "restore":
      if (st.purge_at === null || now >= st.purge_at)
        throw refused("the grace period is over");
      if (await purgeSince(ctx, job.install_id, st.deleted_at ?? 0))
        throw refused("a purge started");
      break;
    case "purge":
      out.skipDirectoryRevoke = await purgePreconditions(
        ctx,
        job,
        st,
        args,
        now,
      );
      break;
    case "discard":
      if (row) throw refused("discard needs a create with no installs row");
      break;
    case "release_lease":
      // 4.4: OIDC never releases a lease.
      if (job.actor_kind === "oidc") throw refused("OIDC has no release_lease");
      if (args.force !== undefined && typeof args.force !== "boolean")
        throw refused("force is not a boolean");
      out.args = { force: args.force === true };
      if (!row) throw refused("no installs row");
      break;
    case "redline_creds":
      // R26 is O only (3.4); TRANSITIONS reads OIDC as A.
      if (job.actor_kind !== "oidc") throw refused("redline_creds is OIDC's");
      if (env !== "staging") throw refused("redline_creds is staging only");
      if (!row || !row.slug.startsWith("rl-") || row.test_hooks !== 1)
        throw refused("not a red-line test install");
      if (row.state !== "active") throw refused("the install is not active");
      break;
    default:
      break;
  }
  return out;
}

/** TRANSITIONS for the job's actor, with the provisioner's own purge. */
async function checkKind(
  ctx: CreateCtx,
  job: JobRow,
  kind: ManageKind,
  st: StatusRow,
): Promise<void> {
  // A prod_dirty create's purge (5.2 x) is the provisioner's own job:
  // system, from failed, compensating that create.
  if (
    kind === "purge" &&
    job.actor_kind === "system" &&
    st.state === "failed" &&
    job.parent_job_id !== null
  ) {
    const parent = await readJob(ctx, job.parent_job_id);
    if (
      parent?.install_id === job.install_id &&
      parent.status === "failed" &&
      parent.error_code === "prod_dirty"
    )
      return;
  }
  checkTransition(st.state, kind, job);
}

const purgeSince = async (ctx: CreateCtx, installId: string, since: number) =>
  (await transient(
    ctx.env.PLATFORM_DB.prepare(
      "SELECT 1 AS x FROM jobs WHERE install_id = ? AND kind = 'purge' AND created_at >= ? LIMIT 1",
    )
      .bind(installId, since)
      .first(),
  )) !== null;

/**
 * R11's skipDirectoryRevoke ({reason}, 3.3), or the flattened reason string;
 * null when absent or malformed.
 */
function skipReason(v: unknown): string | null {
  const r =
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as { reason?: unknown }).reason
      : v;
  return STRING(r, 200) ? r : null;
}

/**
 * 2.5 item 4: a deleting install needs its grace over (purge_at <= now) or
 * an admin purge; a failed create needs installs.state creating (no row is
 * discard's). WfpProvisioner.delete accepts active, so this is the guard.
 * The skip reason: the admin's, or never_routed for a create that never
 * reached HOSTS (no grant is possible before routing).
 */
async function purgePreconditions(
  ctx: CreateCtx,
  job: JobRow,
  st: StatusRow,
  args: Record<string, unknown>,
  now: number,
): Promise<string | undefined> {
  // OIDC purges its own rl- installs as an admin would (4.4), but a
  // skipped directory revoke is an admin's only (5.6, PURGE_FIELD_RULES).
  const admin = job.actor_kind === "admin" || job.actor_kind === "oidc";
  const skip = skipReason(args.skipDirectoryRevoke);
  if (
    args.skipDirectoryRevoke !== undefined &&
    (job.actor_kind !== "admin" || skip === null)
  )
    throw refused("skipDirectoryRevoke is an admin's, with a reason");
  if (st.state === "deleting") {
    // 5.1: S at purge_at unless suspended_at is set.
    if (!admin && st.suspended_at !== null)
      throw refused("a suspended install waits for an admin purge");
    if (
      !admin &&
      !(st.deleted_at !== null && st.purge_at !== null && st.purge_at <= now)
    )
      throw refused("the grace period is not over");
    return skip ?? undefined;
  }
  if (st.state === "failed") {
    const row = await installRow(ctx, job.install_id);
    if (!row || row.state !== "creating")
      throw refused("a failed purge needs a creating installs row");
    if (skip !== null) return skip;
    return (await liveMode(ctx, row)) === "unmapped" ? NEVER_ROUTED : undefined;
  }
  throw refused(`purge is not allowed from ${st.state}`);
}

/**
 * cleanup (3.6, R25 and the sweep): the compensation of a failed or
 * canceled job. The lease is released without force once it has expired
 * (sleeping until then), the job's ss- owner tokens are swept, and the
 * parent is settled with settleFailed. No recheck: it runs on any state.
 */
async function cleanup(
  ctx: CreateCtx,
  jobId: string,
  step: WorkflowStep,
): Promise<void> {
  const s = <T>(
    name: string,
    config: Parameters<typeof jobStep>[4],
    fn: () => Promise<T>,
  ) => jobStep(ctx, step, jobId, name, config, fn);
  const job = await step.do("parent", async () => {
    const j = checkJob(await readJob(ctx, jobId), "manage_install", [
      "cleanup",
    ]);
    const parent = j.parent_job_id ? await readJob(ctx, j.parent_job_id) : null;
    if (
      !parent ||
      parent.install_id !== j.install_id ||
      parent.kind === "cleanup"
    )
      throw refused("a cleanup needs its parent job");
    const row = await installRow(ctx, j.install_id);
    // The label the parent minted its owner token under: a create's or
    // retry's signup (workflow.ts), else labelOf (the install's signup,
    // else the parent job's own id).
    const label =
      parent.workflow === "provision_install"
        ? parent.signup_id
          ? `ss-${parent.signup_id}`
          : null
        : labelOf({
            signupId: (await readStatus(ctx, j.install_id))?.signup_id ?? null,
            jobId: parent.id,
          });
    return {
      installId: j.install_id,
      parentId: parent.id,
      label,
      until: row?.lease ? (row.lease_until ?? 0) : null,
    };
  });
  const { parentId, label } = job;
  // The release never blocks the settle: a lease that failed to go still
  // leaves the parent settled and the tokens swept, then fails the cleanup.
  let released: unknown = null;
  try {
    await releaseWhenExpired(
      ctx,
      step,
      jobId,
      label ?? `ss-${jobId}`,
      job.installId,
      job.until,
    );
  } catch (e) {
    released = e;
  }
  await s("sweep_tokens", undefined, async () =>
    label ? sweepTokens(ctx, label, job.installId, jobId) : { revoked: 0 },
  );
  await s("settle", undefined, async () => {
    const p = await readJob(ctx, parentId);
    const code = jobCode(p?.error_code ?? p?.last_error_code ?? "canceled");
    const db = ctx.env.PLATFORM_DB;
    await transient(
      db.batch([
        ...(p ? [failedAuditStatement(ctx, p, code)] : []),
        ...settleFailedStatements(db, parentId, code, ctx.io.now()),
        ...(await reconcile(ctx, job.installId)),
      ]),
    );
    return { settled: parentId };
  });
  if (released !== null) throw released;
  await s("done", undefined, () =>
    finish(ctx, { jobId, kind: "cleanup", installId: job.installId }),
  );
}

/** How many times cleanup waits again for a lease renewed while it slept. */
export const CLEANUP_LEASE_WAITS = 3;

/**
 * cleanup's lease: sleep until it expires, then release it without force.
 * A lease renewed meanwhile (a step of the canceled run still going) is
 * read again and slept out again, up to CLEANUP_LEASE_WAITS times; then
 * lease_held.
 */
async function releaseWhenExpired(
  ctx: CreateCtx,
  step: WorkflowStep,
  jobId: string,
  label: string,
  installId: string,
  first: number | null,
): Promise<void> {
  let until = first;
  for (let i = 0; ; i++) {
    const n = i === 0 ? "" : `_${i}`;
    if (until !== null && until >= ctx.io.now())
      await step.sleepUntil(`lease_expiry${n}`, new Date(until + 1));
    const r = await jobStep(
      ctx,
      step,
      jobId,
      `release_lease${n}`,
      LEASED_STEP,
      async () => {
        const row = await installRow(ctx, installId);
        if (!row?.lease) return { released: false, until: null };
        const live = row.lease_until ?? 0;
        if (live >= ctx.io.now()) {
          if (i < CLEANUP_LEASE_WAITS) return { released: false, until: live };
          throw new ProvisionRetry(
            "the lease is still held after cleanup waited it out",
            "lease_held",
          );
        }
        const w = await provisionerWith(ctx, label, jobId);
        await w.releaseLease(installId, installId);
        return { released: true, until: null };
      },
      undefined,
      "release_lease",
    );
    if (r.until === null) return;
    until = r.until;
  }
}

/**
 * settleFailed with the stored code and the live serving mode. Returns the
 * lease and its end when an upgrade or rollback left the row upgrading
 * under this job's lease (released by fail_release once it expires, by
 * this stored value: the sleep resumes in a new isolate); a lease another
 * job left is not this one's to release.
 */
async function fail(
  ctx: CreateCtx,
  jobId: string,
  run: RunState,
): Promise<{
  failed: boolean;
  leaseUntil: number | null;
  lease: string | null;
}> {
  const job = await readJob(ctx, jobId);
  if (!job || job.status === "done")
    return { failed: false, leaseUntil: null, lease: null };
  // A dirty script stays prod_dirty even when its pause failed.
  const code = run.dirty
    ? "prod_dirty"
    : jobCode(job.last_error_code ?? job.error_code ?? "internal");
  const db = ctx.env.PLATFORM_DB;
  await transient(
    db.batch([
      failedAuditStatement(ctx, job, code),
      ...settleFailedStatements(db, jobId, code, ctx.io.now()),
      ...(await reconcile(ctx, job.install_id)),
    ]),
  );
  if (job.kind === "upgrade" || job.kind === "rollback") {
    const row = await installRow(ctx, job.install_id);
    if (row && ownLease(job, row, run.claimedLease))
      return {
        failed: true,
        leaseUntil: row.lease_until ?? 0,
        lease: row.lease,
      };
  }
  return { failed: true, leaseUntil: null, lease: null };
}

/** WfpProvisioner's lease length (wfp.ts LEASE_MS; not exported). */
export const CLAIM_LEASE_MS = 30 * 60_000;

/**
 * The row is upgrading under the lease this job's operation claimed: the
 * one this run read at its first step report (RunState.claimedLease), or,
 * when the run never read it (it died between its claim and the first
 * report, or a replay lost the isolate), a lease claimed (or renewed) after
 * the job started. recheck saw the row active then, and jobs_one_active keeps any
 * other job off the install, so that claim is this job's.
 */
function ownLease(
  job: JobRow,
  row: { state: string; lease: string | null; lease_until: number | null },
  claimed: string | null | undefined,
): boolean {
  if (row.state !== "upgrading" || row.lease === null) return false;
  if (claimed !== undefined && claimed !== null) return claimed === row.lease;
  return (
    job.started_at !== null &&
    row.lease_until !== null &&
    row.lease_until - CLAIM_LEASE_MS >= job.started_at
  );
}

/**
 * The expired lease of a row still upgrading, released without force: only
 * the lease the fail step stored, never one claimed during the sleep.
 */
async function releaseExpired(
  ctx: CreateCtx,
  jobId: string,
  lease: string | null,
): Promise<{ released: boolean }> {
  const job = await readJob(ctx, jobId);
  if (!job) return { released: false };
  const row = await installRow(ctx, job.install_id);
  if (
    !row ||
    lease === null ||
    row.state !== "upgrading" ||
    row.lease !== lease
  )
    return { released: false };
  const w = await provisionerWith(ctx, `ss-${job.signup_id ?? jobId}`, jobId);
  await w.releaseLease(job.install_id, job.install_id);
  return { released: true };
}
