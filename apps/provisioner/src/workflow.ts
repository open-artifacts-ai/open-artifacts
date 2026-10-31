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
// that fails for good ends in `fail`, which settles the job (settleFailed)
// and, for prod_dirty, snapshots the script and queues its purge.
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
import {
  type BundleVariant,
  bucketVersions,
  canonicalJson,
  releaseGate as gate,
  NAMESPACES,
  names,
  type R2CatalogBucket,
  r2BindingReleaseReader,
  settleFailedStatements,
  sha256Hex,
} from "@oa/provision";
import {
  bodyHash,
  type WorkflowParams,
  WorkflowParamsSchema,
} from "@oa/shared/provisioning";
import { codeOf } from "./errors.js";
import {
  appHostOf,
  cfFor,
  installRow,
  modeStatement,
  type OpsEnv,
  reconcile,
  renderOptions,
  sweepTokens,
} from "./ops.js";
import { deployEnv, type ProvisionerIo, transient } from "./provisioner.js";
import {
  checkJob,
  checkSlug,
  checkTransition,
  readStatus,
  refused,
  strictVars,
} from "./recheck.js";
import {
  argsOf,
  auditStatement,
  doneStatement,
  jobCode,
  jobStep,
  readJob,
} from "./steps.js";
import { welcomeEmail } from "./welcome.js";

export interface WorkflowEnv extends OpsEnv {
  WELCOME_EMAIL: SendEmail;
  /** The tier a self-serve row must carry (2.5 recheck). */
  SELF_SERVE_TIER: string;
  WELCOME_FROM: string;
  /** A prod_dirty create's purge job starts here (5.2 fail). */
  MANAGE_INSTALL: Workflow<WorkflowParams>;
}

/** The rechecked create job (2.5): what the later steps read. */
export type CreateJob = {
  jobId: string;
  kind: "create" | "retry";
  signupId: string;
  source: "admin" | "self-serve";
  slug: string;
  /** The install id the API assigned (jobs.install_id); reserve stores it. */
  installId: string;
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

/** 2 retries (5.2 step 7); the delay is the runtime default's. */
export const REACHABLE_STEP = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
} as const;

/** reachable polls the public /healthz this long (HOSTS is cached 60 s). */
export const REACHABLE_MS = 180_000;
const REACHABLE_POLL_MS = 5_000;

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
  const s = <T>(
    name: string,
    config: Parameters<typeof jobStep>[4],
    fn: () => Promise<T>,
  ) => jobStep(ctx, step, jobId, name, config, fn);
  try {
    await s("admit", undefined, () => admit(ctx, jobId));
    const job = await s("recheck", undefined, () => recheck(ctx, jobId));
    const { installId } = await s("reserve", undefined, () =>
      reserve(ctx, job),
    );
    const g = await s("release_gate", RELEASE_GATE_STEP, () =>
      releaseGate(ctx, job),
    );
    let email: string | null = null;
    const { appHost } = await jobStep(
      ctx,
      step,
      jobId,
      "create",
      CREATE_STEP,
      () =>
        create(ctx, job, installId, g, (e) => {
          email = e;
        }),
      () => email,
    );
    await s("reachable", REACHABLE_STEP, () =>
      reachable(ctx, installId, appHost),
    );
    await s("notify", undefined, () => notify(ctx, job, appHost));
    await s("done", undefined, () => done(ctx, job, installId));
  } catch (e) {
    // e is the engine's error (a NonRetryableError may arrive without its
    // message): the code is the one the failing attempt stored on the job.
    await step.do("fail", async () => {
      try {
        return await fail(ctx, jobId);
      } catch (f) {
        // Retried; never overwrites the stored code.
        throw new Error(codeOf(f));
      }
    });
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

type SignupRow = {
  signup_id: string;
  source: "admin" | "self-serve";
  slug: string;
  install_id: string | null;
  job_id: string;
  vars: string;
  version: string | null;
  test_hooks: number;
  send_welcome: number;
  status: string;
  admitted_at: number | null;
};

const signupOf = (ctx: CreateCtx, signupId: string) =>
  transient(
    ctx.env.PLATFORM_DB.prepare(
      "SELECT signup_id, source, slug, install_id, job_id, vars, version, test_hooks, send_welcome, status, admitted_at FROM signups WHERE signup_id = ?",
    )
      .bind(signupId)
      .first<SignupRow>(),
  );

/** Admin and OIDC: a no-op; self-serve: the consumer's admit() ran. */
async function admit(
  ctx: CreateCtx,
  jobId: string,
): Promise<{ admitted: true }> {
  const job = checkJob(await readJob(ctx, jobId), "provision_install", [
    "create",
    "retry",
  ]);
  if (!job.signup_id) throw refused("the job has no signup");
  const s = await signupOf(ctx, job.signup_id);
  if (!s) throw refused("no signup");
  if (
    s.source === "self-serve" &&
    (s.admitted_at === null || !["queued", "creating"].includes(s.status))
  )
    throw refused("the signup was not admitted");
  return { admitted: true };
}

/** The 2.5 rechecks: state, transition, strict vars, self-serve tier. */
async function recheck(ctx: CreateCtx, jobId: string): Promise<CreateJob> {
  const env = deployEnv(ctx.env.OA_ENV);
  const job = checkJob(await readJob(ctx, jobId), "provision_install", [
    "create",
    "retry",
  ]);
  const kind = job.kind as "create" | "retry";
  if (!job.signup_id) throw refused("the job has no signup");
  const s = await signupOf(ctx, job.signup_id);
  if (!s || s.job_id !== jobId) throw refused("the signup is not this job's");
  if (s.install_id !== null && s.install_id !== job.install_id)
    throw refused("the signup holds another install");
  const st = await readStatus(ctx, job.install_id);
  if (!st || st.state !== "provisioning")
    throw refused(`the install is ${st?.state ?? "missing"}`);
  if (st.source !== s.source) throw refused("the sources disagree");
  // The API checked the kind against the state before its write: none for
  // a create, failed for a retry.
  checkTransition(kind === "create" ? "none" : "failed", kind, job);
  if ((job.actor_kind === "user") !== (s.source === "self-serve"))
    throw refused("only a self-serve owner creates a self-serve install");
  const slug = checkSlug(s.slug);
  const testHooks = s.test_hooks === 1;
  if (testHooks && s.send_welcome === 1)
    throw refused("a test-hooks install gets no welcome");
  const vars = strictVars(s.vars, {
    source: s.source,
    selfServeTier: ctx.env.SELF_SERVE_TIER,
    testHooks,
    env,
  });
  const args = argsOf(job);
  const v = args.version ?? s.version ?? null;
  if (v !== null && typeof v !== "string") throw refused("bad version");
  if (
    args.version !== undefined &&
    s.version !== null &&
    args.version !== s.version
  )
    throw refused("the job and signup versions disagree");
  return {
    jobId,
    kind,
    signupId: s.signup_id,
    source: s.source,
    slug,
    installId: job.install_id,
    vars,
    version: v,
    testHooks,
    sendWelcome: s.send_welcome === 1,
  };
}

/** install_id = COALESCE(install_id, ?), signups.status creating. */
async function reserve(
  ctx: CreateCtx,
  job: CreateJob,
): Promise<{ installId: string }> {
  const r = await transient(
    ctx.env.PLATFORM_DB.prepare(
      `UPDATE signups SET install_id = COALESCE(install_id, ?2),
   status = CASE status WHEN 'ready' THEN 'ready' ELSE 'creating' END,
   error = NULL, updated_at = ?3
 WHERE signup_id = ?1 AND job_id = ?4 AND status IN ('queued', 'creating', 'ready')
 RETURNING install_id`,
    )
      .bind(job.signupId, job.installId, ctx.io.now(), job.jobId)
      .first<{ install_id: string }>(),
  );
  if (!r || r.install_id !== job.installId)
    throw refused("the signup could not be reserved");
  return { installId: r.install_id };
}

const releaseReader = (ctx: CreateCtx) =>
  r2BindingReleaseReader(
    ctx.env.RELEASES as unknown as R2CatalogBucket,
    deployEnv(ctx.env.OA_ENV),
  );

/** The release record, floor and variant; no Cloudflare writes. */
async function releaseGate(
  ctx: CreateCtx,
  job: CreateJob,
): Promise<ReleaseGate> {
  return gate({
    release: releaseReader(ctx),
    env: deployEnv(ctx.env.OA_ENV),
    version: job.version,
    testHooks: job.testHooks,
    versions: () =>
      bucketVersions(ctx.env.RELEASES as unknown as R2CatalogBucket),
  });
}

/**
 * Sweep, then WfpProvisioner.create with the 5.3 inputs. `onEmail` hands
 * the address to the step wrapper for redaction only.
 */
async function create(
  ctx: CreateCtx,
  job: CreateJob,
  installId: string,
  g: ReleaseGate,
  onEmail: (email: string) => void,
): Promise<{ appHost: string }> {
  const label = `ss-${job.signupId}`;
  // A crashed attempt's token goes first, even if this attempt then fails
  // for good.
  await sweepTokens(ctx, label, installId);
  const appHost = appHostOf(ctx.env, job.slug);
  // A rerun after create finished: the install is already this job's.
  const have = await installRow(ctx, installId);
  if (have && have.slug === job.slug && have.state === "active") {
    await transient(modeStatement(ctx, installId, "serving").run());
    return { appHost: have.app_host };
  }
  const email = await ownerEmail(ctx, job.signupId);
  if (email === null) throw new NonRetryableError("internal");
  onEmail(email);
  const p = await renderOptions(ctx, {
    jobId: job.jobId,
    label,
    installId,
    appHost,
    vars: job.vars,
    testHooks: job.testHooks,
  });
  const inst = await p.create({
    slug: job.slug,
    ownerEmail: email,
    plan: "paid",
    vars: job.vars,
    testHooks: job.testHooks,
    bundle: g.bundle,
    version: g.version,
    installId,
  });
  await transient(modeStatement(ctx, installId, "serving").run());
  return { appHost: inst.appHost };
}

/**
 * Public /healthz through dispatch, up to REACHABLE_MS; records the result
 * on the lifecycle row and never fails the job (the scheduler opens
 * unreachable_after_route on `failing`).
 */
async function reachable(
  ctx: CreateCtx,
  installId: string,
  appHost: string,
): Promise<{ ok: boolean }> {
  const until = ctx.io.now() + REACHABLE_MS;
  let ok = false;
  for (;;) {
    try {
      const res = await ctx.io.fetch(`https://${appHost}/healthz`, {
        redirect: "manual",
      });
      const b = (await res.json().catch(() => null)) as {
        ok?: unknown;
        installId?: unknown;
      } | null;
      ok = res.status === 200 && b?.ok === true && b.installId === installId;
    } catch {
      ok = false;
    }
    if (ok || ctx.io.now() >= until) break;
    await ctx.io.sleep(REACHABLE_POLL_MS);
  }
  const now = ctx.io.now();
  await ctx.env.PLATFORM_DB.prepare(
    "UPDATE install_lifecycle SET health = ?2, health_at = ?3, updated_at = ?3 WHERE install_id = ?1",
  )
    .bind(installId, ok ? "ok" : "failing", now)
    .run()
    .catch(() => {});
  return { ok };
}

/** At most one welcome, only when send_welcome = 1 (claim before send). */
async function notify(
  ctx: CreateCtx,
  job: CreateJob,
  appHost: string,
): Promise<{ sent: boolean }> {
  if (!job.sendWelcome) return { sent: false };
  const db = ctx.env.PLATFORM_DB;
  const claim = await transient(
    db
      .prepare(
        "UPDATE signups SET welcome_claimed_at = ? WHERE signup_id = ? AND send_welcome = 1 AND welcome_claimed_at IS NULL",
      )
      .bind(ctx.io.now(), job.signupId)
      .run(),
  );
  if (claim.meta.changes !== 1) return { sent: false };
  const to = await ownerEmail(ctx, job.signupId);
  // Claimed, never sent: the scheduler's welcome_unsent alert says so.
  if (to === null) throw new NonRetryableError("internal");
  await ctx.env.WELCOME_EMAIL.send(
    welcomeEmail({ from: ctx.env.WELCOME_FROM, to, appHost }),
  );
  await transient(
    db
      .prepare(
        "UPDATE signups SET welcome_sent_at = ?1, updated_at = ?1 WHERE signup_id = ?2",
      )
      .bind(ctx.io.now(), job.signupId)
      .run(),
  );
  return { sent: true };
}

/** Sweep, delete signup_secret, signups ready, job done, audit. */
async function done(
  ctx: CreateCtx,
  job: CreateJob,
  installId: string,
): Promise<{ ready: true }> {
  await sweepTokens(ctx, `ss-${job.signupId}`, installId);
  const db = ctx.env.PLATFORM_DB;
  const now = ctx.io.now();
  // The job first: the rest only follow a job this run finished.
  const mine = "EXISTS (SELECT 1 FROM jobs WHERE id = ?2 AND status = 'done')";
  await transient(
    db.batch([
      doneStatement(ctx, job.jobId),
      db
        .prepare(`DELETE FROM signup_secret WHERE signup_id = ?1 AND ${mine}`)
        .bind(job.signupId, job.jobId),
      db
        .prepare(
          `UPDATE signups SET status = 'ready', error = NULL, updated_at = ?3 WHERE signup_id = ?1 AND job_id = ?2 AND ${mine}`,
        )
        .bind(job.signupId, job.jobId, now),
      auditStatement(ctx, installId, `job.${job.kind}.done`, {
        jobId: job.jobId,
      }),
    ]),
  );
  return { ready: true };
}

/**
 * The end of a failed run (5.2 x): one D1 batch, in order, of the
 * prod_dirty snapshot (secret names, typed bindings, release record and
 * metadata hashes), settleFailed with the stored code, the live serving
 * mode, and for prod_dirty a purge job (system:provisioner); then the purge
 * starts and the ss- tokens are swept.
 */
async function fail(
  ctx: CreateCtx,
  jobId: string,
): Promise<{ failed: boolean }> {
  const job = await readJob(ctx, jobId);
  if (!job || job.status === "done") return { failed: false };
  const code = jobCode(job.last_error_code ?? job.error_code ?? "internal");
  const db = ctx.env.PLATFORM_DB;
  const row = await installRow(ctx, job.install_id);
  const dirty = code === "prod_dirty" && row !== null;
  const snapshot = dirty ? [await snapshotStatement(ctx, job.install_id)] : [];
  const purge = dirty ? await purgeJob(ctx, job.install_id, jobId) : null;
  const res = await transient(
    db.batch<{ id: string }>([
      ...snapshot,
      ...settleFailedStatements(db, jobId, code, ctx.io.now()),
      ...(await reconcile(ctx, job.install_id)),
      ...(purge ? [purge.statement] : []),
    ]),
  );
  // Inserted by this batch (not an earlier attempt's, nor refused by
  // jobs_one_active): start it.
  if (purge && res.at(-1)?.results[0]?.id === purge.id)
    await ctx.env.MANAGE_INSTALL.create({
      id: purge.id,
      params: { jobId: purge.id },
    }).catch(() => {
      // Left queued: the scheduler's sweep starts it (5.8).
    });
  if (job.signup_id && row)
    await sweepTokens(ctx, `ss-${job.signup_id}`, job.install_id).catch(
      () => {},
    );
  return { failed: true };
}

/**
 * The prod_dirty snapshot (hosted_audit, append-only): the script's secret
 * names and binding (name, type) pairs as served now, and the hashes of the
 * release record and the stored metadata. No value of any binding.
 */
async function snapshotStatement(
  ctx: CreateCtx,
  installId: string,
): Promise<D1PreparedStatement> {
  const e = deployEnv(ctx.env.OA_ENV);
  const row = await installRow(ctx, installId);
  const detail: Record<string, string> = {};
  try {
    const cf = await cfFor(ctx);
    const target = { kind: "namespace" as const, ns: NAMESPACES[e] };
    const script = names(installId, e).script;
    const { bindings } = await cf.scriptSettings(target, script);
    detail.bindings = bindings
      .map((b) => `${b.name}:${b.type}`)
      .sort()
      .join(",");
    detail.secrets = (await cf.secretList(target, script)).sort().join(",");
  } catch {
    detail.settings = "unavailable";
  }
  const v = row?.version
    ? await ctx.env.PLATFORM_DB.prepare(
        "SELECT metadata FROM install_versions WHERE install_id = ? AND version = ?",
      )
        .bind(installId, row.version)
        .first<{ metadata: string }>()
        .catch(() => null)
    : null;
  detail.metadata = v ? sha256Hex(v.metadata) : "";
  if (row?.version) {
    const rec = await releaseReader(ctx)
      .record(row.version, row.test_hooks === 1 ? "redline" : "release")
      .catch(() => null);
    detail.record = rec ? sha256Hex(canonicalJson(rec)) : "";
  }
  return auditStatement(ctx, installId, "prod_dirty.snapshot", detail);
}

/** The purge job a prod_dirty create leaves (actor system:provisioner). */
async function purgeJob(
  ctx: CreateCtx,
  installId: string,
  parentJobId: string,
): Promise<{ id: string; statement: D1PreparedStatement }> {
  const now = ctx.io.now();
  const id = jobUlid(now);
  const requestId = `prod-dirty-${parentJobId}`;
  const hash = await bodyHash("R11", installId, { requestId });
  return {
    id,
    statement: ctx.env.PLATFORM_DB.prepare(
      `INSERT INTO jobs (id, kind, workflow, install_id, parent_job_id, actor_kind, actor_key, actor_label, request_id, body_hash, args, status, created_at, updated_at)
VALUES (?1, 'purge', 'manage_install', ?2, ?3, 'system', 'system:provisioner', 'provisioner', ?4, ?5, '{}', 'queued', ?6, ?6)
ON CONFLICT DO NOTHING RETURNING id`,
    ).bind(id, installId, parentJobId, requestId, hash, now),
  };
}

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** A ULID for a job the provisioner inserts. */
export function jobUlid(now: number): string {
  let t = "";
  let n = now;
  for (let i = 0; i < 10; i++) {
    t = B32[n % 32] + t;
    n = Math.floor(n / 32);
  }
  const r = crypto.getRandomValues(new Uint8Array(16));
  let rand = "";
  for (const b of r) rand += B32[b % 32];
  return t + rand;
}
