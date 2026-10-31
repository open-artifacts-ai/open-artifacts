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
  checkTransition,
  readStatus,
  refused,
  type StatusRow,
} from "./recheck.js";
import { redlineCreds } from "./redline.js";
import {
  argsOf,
  auditStatement,
  doneStatement,
  type JobRow,
  jobCode,
  jobStep,
  markStep,
  readJob,
} from "./steps.js";
import { type CreateCtx, RUNTIME_IO, type WorkflowEnv } from "./workflow.js";

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

/** upgrade and rollback: 2 attempts, 2 minutes; an attempt up to 45 minutes. */
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
    const f = await step.do("fail", async () => {
      try {
        return await fail(ctx, jobId);
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
          return await releaseExpired(ctx, jobId);
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
    provisionerWith(ctx, labelOf(j), { registryDisabled: j.registryDisabled });
  switch (job.kind) {
    case "upgrade": {
      if (!job.already) {
        const g = await s("release_gate", undefined, () =>
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
        await s("upload", MANAGE_UPLOAD_STEP, () =>
          render(ctx, job, "upgrade", g.version),
        );
      }
      break;
    }
    case "rollback":
      if (!job.already)
        await s("upload", MANAGE_UPLOAD_STEP, () =>
          render(ctx, job, "rollback", job.args.to as string),
        );
      break;
    case "suspend":
      await s("pause", LEASED_STEP, async () => {
        await (await p(job)).pause(job.installId, "paused", { kind: "suspend" });
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
          onPoll: () => markStep(ctx, jobId, "revoke_directory"),
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
 * mapping: ok is done; a dirty serving script is paused, then `prod_dirty`;
 * a forward fix is `upgrade_incomplete`; a rollback is `upgrade_rolled_back`.
 * Check-first: an install already on `to` and active is done, no call.
 */
async function render(
  ctx: CreateCtx,
  job: ManageJob,
  kind: "upgrade" | "rollback",
  to: string,
): Promise<{ version: string }> {
  const row = await installRow(ctx, job.installId);
  if (!row) throw refused("no installs row");
  if (row.version === to && row.state === "active") return { version: to };
  if (row.version !== job.args.from) throw refused("the version moved");
  const w = await renderOptions(ctx, {
    jobId: job.jobId,
    label: labelOf(job),
    installId: job.installId,
    appHost: row.app_host,
    vars: storedVars(row.vars),
    testHooks: row.test_hooks === 1,
    registryDisabled: job.registryDisabled,
  });
  const r: UpgradeResult =
    kind === "upgrade"
      ? await w.upgrade(job.installId, to)
      : await w.rollback(job.installId);
  if (r.ok) return { version: r.to };
  if (r.prodDirty) {
    await (await provisionerWith(ctx, labelOf(job))).pause(
      job.installId,
      "paused",
      { kind },
    );
    await transient(modeStatement(ctx, job.installId, "paused").run());
    throw new ProvisionRefused(
      `${kind} left a script that fails verify_clean; paused`,
      "prod_dirty",
    );
  }
  if (kind === "upgrade" && r.rolledBack && !r.forwardFix)
    throw new ProvisionRefused(
      `upgrade to ${to} failed and rolled back to ${r.from}`,
      "upgrade_rolled_back",
    );
  throw new ProvisionRefused(
    `${kind} to ${to} did not finish; a forward fix is needed`,
    "upgrade_incomplete",
  );
}

/** The job done, audited; only while it is open. */
async function finish(
  ctx: CreateCtx,
  job: { jobId: string; kind: string; installId: string },
): Promise<{ done: true }> {
  await transient(
    ctx.env.PLATFORM_DB.batch([
      doneStatement(ctx, job.jobId),
      auditStatement(ctx, job.installId, `job.${job.kind}.done`, {
        jobId: job.jobId,
      }),
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
  const now = ctx.io.now();
  switch (kind) {
    case "upgrade":
    case "rollback": {
      if (!STRING(args.from, 20) || !STRING(args.to, 20))
        throw refused("the job has no from and to");
      if (!row) throw refused("no installs row");
      out.args = { from: args.from, to: args.to };
      if (kind === "rollback" && row.previous_version !== args.to && row.version !== args.to)
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
      out.skipDirectoryRevoke = await purgePreconditions(ctx, job, st, args, now);
      break;
    case "discard":
      if (row) throw refused("discard needs a create with no installs row");
      break;
    case "release_lease":
      if (args.force !== undefined && typeof args.force !== "boolean")
        throw refused("force is not a boolean");
      out.args = { force: args.force === true };
      if (!row) throw refused("no installs row");
      break;
    case "redline_creds":
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
  const admin = job.actor_kind === "admin" || job.actor_kind === "oidc";
  const skip = args.skipDirectoryRevoke;
  if (skip !== undefined && (!admin || !STRING(skip, 200)))
    throw refused("skipDirectoryRevoke is an admin's, with a reason");
  if (st.state === "deleting") {
    if (!admin && !(st.deleted_at !== null && st.purge_at !== null && st.purge_at <= now))
      throw refused("the grace period is not over");
    return skip as string | undefined;
  }
  if (st.state === "failed") {
    const row = await installRow(ctx, job.install_id);
    if (!row || row.state !== "creating")
      throw refused("a failed purge needs a creating installs row");
    if (skip !== undefined) return skip as string;
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
    if (!parent || parent.install_id !== j.install_id || parent.kind === "cleanup")
      throw refused("a cleanup needs its parent job");
    const row = await installRow(ctx, j.install_id);
    return {
      installId: j.install_id,
      parentId: parent.id,
      signupId: parent.signup_id ?? j.signup_id,
      until: row?.lease ? (row.lease_until ?? 0) : null,
    };
  });
  const { parentId, signupId } = job;
  const until = { until: job.until };
  if (until.until !== null && until.until >= ctx.io.now())
    await step.sleepUntil("lease_expiry", new Date(until.until + 1));
  await s("release_lease", LEASED_STEP, async () => {
    const row = await installRow(ctx, job.installId);
    if (!row?.lease) return { released: false };
    const w = await provisionerWith(ctx, `ss-${signupId ?? jobId}`);
    await w.releaseLease(job.installId, job.installId);
    return { released: true };
  });
  await s("sweep_tokens", undefined, async () =>
    signupId
      ? sweepTokens(ctx, `ss-${signupId}`, job.installId)
      : { revoked: 0 },
  );
  await s("settle", undefined, async () => {
    const p = await readJob(ctx, parentId);
    const code = jobCode(p?.error_code ?? p?.last_error_code ?? "canceled");
    const db = ctx.env.PLATFORM_DB;
    await transient(
      db.batch([
        ...settleFailedStatements(db, parentId, code, ctx.io.now()),
        ...(await reconcile(ctx, job.installId)),
      ]),
    );
    return { settled: parentId };
  });
  await s("done", undefined, () =>
    finish(ctx, { jobId, kind: "cleanup", installId: job.installId }),
  );
}

/**
 * settleFailed with the stored code and the live serving mode. Returns the
 * lease end when an upgrade or rollback left the row upgrading under a
 * lease (released by fail_release once it expires).
 */
async function fail(
  ctx: CreateCtx,
  jobId: string,
): Promise<{ failed: boolean; leaseUntil: number | null }> {
  const job = await readJob(ctx, jobId);
  if (!job || job.status === "done") return { failed: false, leaseUntil: null };
  const code = jobCode(job.last_error_code ?? job.error_code ?? "internal");
  const db = ctx.env.PLATFORM_DB;
  await transient(
    db.batch([
      ...settleFailedStatements(db, jobId, code, ctx.io.now()),
      ...(await reconcile(ctx, job.install_id)),
    ]),
  );
  let leaseUntil: number | null = null;
  if (job.kind === "upgrade" || job.kind === "rollback") {
    const row = await installRow(ctx, job.install_id);
    if (row?.state === "upgrading" && row.lease !== null)
      leaseUntil = row.lease_until ?? 0;
  }
  return { failed: true, leaseUntil };
}

/** The expired lease of a row still upgrading, released without force. */
async function releaseExpired(
  ctx: CreateCtx,
  jobId: string,
): Promise<{ released: boolean }> {
  const job = await readJob(ctx, jobId);
  if (!job) return { released: false };
  const row = await installRow(ctx, job.install_id);
  if (row?.state !== "upgrading" || row.lease === null)
    return { released: false };
  const w = await provisionerWith(ctx, `ss-${job.signup_id ?? jobId}`);
  await w.releaseLease(job.install_id, job.install_id);
  return { released: true };
}
