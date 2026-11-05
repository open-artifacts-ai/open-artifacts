// The OAuth store jobs (#1008 PR1), the `update` kind's two operations.
//
// R29, set: a read of /healthz refuses what the store itself would refuse,
// before any write; provision's updateVars puts the mode on the live version;
// /healthz must then show it. The verified mode goes on hosted_audit, which
// is what R30 reads for when dual went live.
//
// R30, copy: the route contract is on #1008 (apps/server's oauth-copy.ts).
// OAUTH_COPY_KEY exists for this job alone: put, proven live, used one page
// per step, deleted; a key that won't delete is rotated to one nobody holds.
// Every stop after the put goes through the delete, and cleanup does it for a
// run that was canceled or died. No lease is held: jobs_one_active keeps other
// jobs off, and the copy changes neither the script nor the row.
//
// The key and the cursors live only in step state (the steps' results, which
// a replay needs). They never reach jobs.args, an audit row or a log, and no
// error here quotes a value or a response body.
import type { WorkflowStep } from "cloudflare:workers";
import {
  CfError,
  directFetch,
  NAMESPACES,
  names,
  newSecret,
  ProvisionRefused,
} from "@oa/provision";
import {
  COPY_KEY_GONE_ACTION,
  COPY_KEY_LEFT_SQL,
  dualLiveAt,
  OAUTH_DUAL_SETTLE_MS,
  OAUTH_MODE_LIVE_ACTION,
  OAUTH_MODE_LIVE_SQL,
  type OAuthStoreMode,
  storedOAuthMode,
} from "@oa/provisioning-contract";
import { failingAt, tagFail } from "./errors.js";
import type { ManageJob } from "./manage.js";
import {
  cfFor,
  type InstallRowLite,
  installRow,
  provisionerWith,
  renderOptions,
  storedVars,
} from "./ops.js";
import { deployEnv, transient } from "./provisioner.js";
import { refused } from "./recheck.js";
import { KEY_LIVE_WAITS_MS } from "./redline.js";
import { auditStatement, jobStep } from "./steps.js";
import type { CreateCtx } from "./workflow.js";

const KEY = "OAUTH_COPY_KEY";
export const OAUTH_COPY_PATH = "/__oa/oauth-store/copy";

/** A read of the install, or one Cloudflare call: short, and retried. */
export const OAUTH_READ_STEP = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} as const;
/** The mode's upload, as an upgrade's. */
export const OAUTH_UPLOAD_STEP = {
  retries: { limit: 2, delay: "2 minutes", backoff: "exponential" },
  timeout: "45 minutes",
} as const;
/** How long a new version's mode may take to show on /healthz. */
export const MODE_LIVE_WAITS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];
/** Each page's lead: RL_ANON allows 30 calls a minute, so 24 stays under. */
export const COPY_PACE_MS = 2_500;
/** A reasonless 404 mid-loop is RL_ANON: these, then the step's own retries. */
export const COPY_LIMIT_WAITS_MS = [5_000, 10_000, 20_000, 30_000];
/**
 * How long after a run stops a put_key it had in flight may still land: the
 * put step's attempt timeout (OAUTH_READ_STEP). A delete before then is
 * done again after it.
 */
export const COPY_KEY_SETTLE_MS = 5 * 60_000;
/**
 * Pages in one job, restarts included: 720,000 keys at 800 a page, and under
 * a Workflow's step limit. A pass that never ends fails rather than loops.
 */
export const COPY_MAX_PAGES = 900;

type Health = {
  mode: string;
  backfilled: boolean;
  kvWritesOffSince: number | null;
};
type Install = { f: typeof fetch; app: string; row: InstallRowLite };

async function installOf(ctx: CreateCtx, job: ManageJob): Promise<Install> {
  const row = await installRow(ctx, job.installId);
  if (!row || row.state !== "active")
    throw refused("the install is not active");
  const script = names(row.id, deployEnv(ctx.env.OA_ENV)).script;
  return {
    row,
    app: `https://${row.app_host}`,
    f: directFetch(ctx.env.DISPATCHER, { appHost: row.app_host, script }),
  };
}

/** /healthz's oauthStore. Anything else throws: never read as a mode. */
async function health(i: Install): Promise<Health> {
  const res = await failingAt("oauth_healthz", () =>
    i.f(`${i.app}/healthz`, { redirect: "manual" }),
  );
  if (res.status !== 200) {
    await res.body?.cancel();
    throw tagFail(
      new Error(`healthz: HTTP ${res.status}`),
      "oauth_healthz",
      res.status,
    );
  }
  const b = (await res.json().catch(() => null)) as {
    oauthStore?: Partial<Health> | null;
  } | null;
  const s = b?.oauthStore;
  if (typeof s?.mode !== "string" || typeof s.backfilled !== "boolean")
    throw tagFail(new Error("healthz: no oauthStore"), "oauth_healthz");
  return {
    mode: s.mode,
    backfilled: s.backfilled,
    kvWritesOffSince:
      typeof s.kvWritesOffSince === "number" ? s.kvWritesOffSince : null,
  };
}

/**
 * Refuses, before any write, what the store would refuse at serve time: both
 * are a 503 for every client otherwise. Leaving d1 is judged on the stored
 * vars, /healthz and the stamp, each enough alone. d1 needs a complete copy
 * read in dual (kv clears the marker lazily, so kv's `backfilled` can be
 * stale), or no KV bound, with nothing to copy.
 */
async function checkModeChange(
  ctx: CreateCtx,
  job: ManageJob,
  want: OAuthStoreMode,
): Promise<{ ok: true }> {
  const i = await installOf(ctx, job);
  const h = await health(i);
  if (want !== "d1") {
    if (
      h.mode === "d1" ||
      h.kvWritesOffSince !== null ||
      storedOAuthMode(i.row.vars) === "d1"
    )
      throw new ProvisionRefused("leaving d1 is refused", "leave_d1_refused");
    return { ok: true };
  }
  if (h.mode === "d1" || (h.mode === "dual" && h.backfilled))
    return { ok: true };
  const e = deployEnv(ctx.env.OA_ENV);
  const { bindings } = await (await cfFor(ctx)).scriptSettings(
    { kind: "namespace", ns: NAMESPACES[e] },
    names(i.row.id, e).script,
  );
  if (bindings.some((b) => b.name === "OAUTH_KV"))
    throw new ProvisionRefused("no complete copy", "copy_incomplete");
  return { ok: true };
}

/** updateVars with the merged vars. A LostLease leaves as it came. */
async function putMode(
  ctx: CreateCtx,
  job: ManageJob,
  label: string,
  want: OAuthStoreMode,
): Promise<{ version: string }> {
  const row = await installRow(ctx, job.installId);
  if (!row) throw refused("no installs row");
  const vars = { ...storedVars(row.vars), OAUTH_STORE: want };
  const w = await renderOptions(ctx, {
    jobId: job.jobId,
    label,
    installId: job.installId,
    appHost: row.app_host,
    vars,
    testHooks: row.test_hooks === 1,
    registryDisabled: job.registryDisabled,
  });
  const r = await w.updateVars(job.installId, vars);
  // The new vars are live but a check after them failed: a person looks.
  if (!r.ok)
    throw new ProvisionRefused(
      "the checks after the var change failed",
      "upgrade_incomplete",
    );
  return { version: r.version };
}

/** /healthz until it shows `want`; a read that fails counts as not yet. */
async function modeLive(
  ctx: CreateCtx,
  job: ManageJob,
  want: OAuthStoreMode,
): Promise<{ mode: OAuthStoreMode }> {
  const i = await installOf(ctx, job);
  for (let n = 0; ; n++) {
    const h = await health(i).catch(() => null);
    if (h?.mode === want) break;
    const wait = MODE_LIVE_WAITS_MS[n];
    if (wait === undefined)
      throw new ProvisionRefused(
        "/healthz does not show the mode",
        "mode_not_live",
      );
    await ctx.io.sleep(wait);
  }
  await transient(
    auditStatement(
      ctx,
      job.installId,
      OAUTH_MODE_LIVE_ACTION,
      { mode: want },
      job.jobId,
    ).run(),
  );
  return { mode: want };
}

/** R29's steps. No catch here: LostLease must reach the step as it is. */
export async function setOAuthStore(
  ctx: CreateCtx,
  step: WorkflowStep,
  job: ManageJob,
  label: string,
  want: OAuthStoreMode,
): Promise<void> {
  const { jobId } = job;
  await jobStep(ctx, step, jobId, "precheck", OAUTH_READ_STEP, () =>
    checkModeChange(ctx, job, want),
  );
  await jobStep(ctx, step, jobId, "update_vars", OAUTH_UPLOAD_STEP, () =>
    putMode(ctx, job, label, want),
  );
  await jobStep(ctx, step, jobId, "mode_live", undefined, () =>
    modeLive(ctx, job, want),
  );
}

/** A copy's preconditions, before the key exists. */
async function checkCopy(
  ctx: CreateCtx,
  job: ManageJob,
  label: string,
): Promise<{ ok: true }> {
  const i = await installOf(ctx, job);
  if (
    storedOAuthMode(i.row.vars) !== "dual" ||
    (await health(i)).mode !== "dual"
  )
    throw new ProvisionRefused("the install is not in dual", "copy_not_dual");
  const live = dualLiveAt(
    await transient(
      ctx.env.PLATFORM_DB.prepare(OAUTH_MODE_LIVE_SQL)
        .bind(job.installId)
        .first<{ at: number; detail: string | null }>(),
    ),
  );
  if (live === null || ctx.io.now() - live < OAUTH_DUAL_SETTLE_MS)
    throw refused("dual has not been live long enough");
  // 5.7: refused near expiry, while no key is up.
  await (await provisionerWith(ctx, label, job.jobId)).verifyToken("refuse");
  return { ok: true };
}

const scriptTarget = (ctx: CreateCtx, installId: string) => {
  const e = deployEnv(ctx.env.OA_ENV);
  return {
    target: { kind: "namespace" as const, ns: NAMESPACES[e] },
    script: names(installId, e).script,
  };
};

async function putKey(ctx: CreateCtx, installId: string): Promise<string> {
  const { target, script } = scriptTarget(ctx, installId);
  const key = newSecret();
  await (await cfFor(ctx)).secretPut(target, script, KEY, key);
  return key;
}

const copyCall = (i: Install, key: string, body: string) =>
  i.f(`${i.app}${OAUTH_COPY_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body,
    redirect: "manual",
  });

/** A copy refusal's fixed reason (error.details.reason); never the body. */
async function reasonOf(res: Response): Promise<string | null> {
  const b = (await res.json().catch(() => null)) as {
    error?: { details?: { reason?: unknown } };
  } | null;
  const r = b?.error?.details?.reason;
  return typeof r === "string" ? r : null;
}

function refuseCopy(reason: string | null): void {
  if (reason === "not_dual")
    throw new ProvisionRefused("refused: not dual", "copy_not_dual");
  if (reason === "markers")
    throw new ProvisionRefused("refused: markers", "copy_markers");
}

/**
 * Polls `[]` until 404 bad_input, which the route answers only to the live
 * key, and copies nothing. A 503 before the key verifies is a markers
 * refusal: terminal.
 */
async function keyLive(
  ctx: CreateCtx,
  job: ManageJob,
  key: string,
): Promise<{ live: true }> {
  const i = await installOf(ctx, job);
  for (let n = 0; ; n++) {
    const res = await failingAt("copy_key_live", () => copyCall(i, key, "[]"));
    const reason = res.status === 404 ? await reasonOf(res) : null;
    if (res.status !== 404) await res.body?.cancel();
    if (reason === "bad_input") return { live: true };
    if (res.status === 503) refuseCopy("markers");
    refuseCopy(reason);
    const wait = KEY_LIVE_WAITS_MS[n];
    if (wait === undefined)
      throw tagFail(
        new ProvisionRefused("the key is not live", "copy_key_not_live"),
        "copy_key_live",
        res.status,
      );
    await ctx.io.sleep(wait);
  }
}

type Counts = { kvKeys: number; copied: number; skippedExpiring: number };
type CopyPage = Counts & {
  d1Rows: number | null;
  nextCursor: string | null;
  restarted: boolean;
};

function pageOf(v: unknown): CopyPage {
  const p = v as Partial<CopyPage> | null;
  const n = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  if (
    !p ||
    !n(p.kvKeys) ||
    !n(p.copied) ||
    !n(p.skippedExpiring) ||
    !(p.d1Rows === null || n(p.d1Rows)) ||
    !(
      p.nextCursor === null ||
      (typeof p.nextCursor === "string" && p.nextCursor !== "")
    ) ||
    typeof p.restarted !== "boolean"
  )
    throw tagFail(new Error("copy page: not a page"), "copy_page");
  return {
    kvKeys: p.kvKeys as number,
    copied: p.copied as number,
    skippedExpiring: p.skippedExpiring as number,
    d1Rows: p.d1Rows as number | null,
    nextCursor: p.nextCursor as string | null,
    restarted: p.restarted,
  };
}

/** One page. `{}` only as the pass's first call: a cursor is never dropped. */
async function copyPage(
  ctx: CreateCtx,
  job: ManageJob,
  key: string,
  cursor: string | null,
  n: number,
): Promise<CopyPage> {
  if (n >= COPY_MAX_PAGES)
    throw new ProvisionRefused("too many pages", "copy_incomplete");
  const i = await installOf(ctx, job);
  const body = cursor === null ? "{}" : JSON.stringify({ cursor });
  await ctx.io.sleep(COPY_PACE_MS);
  for (let t = 0; ; t++) {
    const res = await failingAt("copy_page", () => copyCall(i, key, body));
    if (res.status === 200) {
      const p = pageOf(await res.json().catch(() => null));
      if (p.nextCursor === null && p.d1Rows === null)
        throw new ProvisionRefused("no final count", "copy_incomplete");
      return p;
    }
    if (res.status !== 404) {
      await res.body?.cancel();
      throw tagFail(
        new Error(`copy page: HTTP ${res.status}`),
        "copy_page",
        res.status,
      );
    }
    const reason = await reasonOf(res);
    refuseCopy(reason);
    const wait = reason === null ? COPY_LIMIT_WAITS_MS[t] : undefined;
    if (wait === undefined)
      throw tagFail(new Error("copy page: refused"), "copy_page", 404);
    await ctx.io.sleep(wait);
  }
}

/** The counts of a job's pages: per cursor, last write wins, then summed. */
export function sumPages(pages: ReadonlyMap<string, Counts>): Counts {
  const sum = { kvKeys: 0, copied: 0, skippedExpiring: 0 };
  for (const p of pages.values()) {
    sum.kvKeys += p.kvKeys;
    sum.copied += p.copied;
    sum.skippedExpiring += p.skippedExpiring;
  }
  return sum;
}

/** The loop: each page a step, so a retry resends its own cursor. */
async function copyAll(
  ctx: CreateCtx,
  step: WorkflowStep,
  job: ManageJob,
  key: string,
): Promise<void> {
  const pages = new Map<string, Counts>();
  let cursor: string | null = null;
  let d1Rows: number | null = null;
  for (let n = 0; ; n++) {
    const from: string | null = cursor;
    const p: CopyPage = await jobStep(
      ctx,
      step,
      job.jobId,
      `copy_${n}`,
      OAUTH_READ_STEP,
      () => copyPage(ctx, job, key, from, n),
      "copy",
    );
    if (p.restarted) pages.clear();
    pages.set(from ?? "", p);
    cursor = p.nextCursor;
    d1Rows = p.d1Rows;
    if (cursor === null) break;
  }
  const counts = { ...sumPages(pages), d1Rows: d1Rows ?? 0 };
  await jobStep(
    ctx,
    step,
    job.jobId,
    "copy_counts",
    OAUTH_READ_STEP,
    async () => {
      const now = ctx.io.now();
      await transient(
        ctx.env.PLATFORM_DB.batch([
          ctx.env.PLATFORM_DB.prepare(
            "UPDATE jobs SET args = ?2, updated_at = ?3 WHERE id = ?1 AND status IN ('queued', 'running')",
          ).bind(job.jobId, JSON.stringify({ oauthCopy: true, counts }), now),
          auditStatement(
            ctx,
            job.installId,
            "oauth_copy.counts",
            counts,
            job.jobId,
          ),
        ]),
      );
      return counts;
    },
    "copy",
  );
}

/**
 * Off the script, so the route goes back to an unknown 404: deleted (gone
 * already is fine), else rotated to a value nobody holds; a key left either
 * way is copy_key_left. A job already closed fails each step at its mark,
 * and R25's cleanup does this instead.
 */
export async function dropCopyKey(
  ctx: CreateCtx,
  step: WorkflowStep,
  jobId: string,
  installId: string,
  mark = "drop_key",
  n = "",
): Promise<void> {
  const { target, script } = scriptTarget(ctx, installId);
  const dropped = await jobStep(
    ctx,
    step,
    jobId,
    `drop_copy_key${n}`,
    OAUTH_READ_STEP,
    async () => {
      try {
        await (await cfFor(ctx)).secretDelete(target, script, KEY);
      } catch (e) {
        if (!(e instanceof CfError && e.status === 404)) throw e;
      }
      await transient(
        auditStatement(ctx, installId, COPY_KEY_GONE_ACTION, {}, jobId).run(),
      );
      return { dropped: true };
    },
    mark,
  ).catch(() => null);
  if (dropped) return;
  await jobStep(
    ctx,
    step,
    jobId,
    `rotate_copy_key${n}`,
    OAUTH_READ_STEP,
    async () => {
      await putKey(ctx, installId);
      return { rotated: true };
    },
    mark,
  ).catch(() => null);
  await jobStep(
    ctx,
    step,
    jobId,
    `copy_key_left${n}`,
    undefined,
    async () => {
      throw new ProvisionRefused("the key was not deleted", "copy_key_left");
    },
    mark,
  );
}

async function verifyBackfilled(
  ctx: CreateCtx,
  job: ManageJob,
): Promise<{ backfilled: true }> {
  const h = await health(await installOf(ctx, job));
  if (!h.backfilled)
    throw new ProvisionRefused("not backfilled", "copy_incomplete");
  return { backfilled: true };
}

/**
 * dropCopyKey after a run that may have had a put in flight (canceled, dead,
 * or its own put_key failed): once now, then again once that put could no
 * longer land (`stoppedAt` + COPY_KEY_SETTLE_MS).
 */
export async function dropCopyKeySettled(
  ctx: CreateCtx,
  step: WorkflowStep,
  jobId: string,
  installId: string,
  stoppedAt: number,
  mark = "drop_key",
): Promise<void> {
  await dropCopyKey(ctx, step, jobId, installId, mark);
  const at = stoppedAt + COPY_KEY_SETTLE_MS;
  if (at >= ctx.io.now())
    await step.sleepUntil("copy_key_settle", new Date(at + 1));
  await dropCopyKey(ctx, step, jobId, installId, mark, "_2");
}

/** A left key still open on the install; a read that fails is no. */
export async function leftKeyOpen(
  ctx: CreateCtx,
  installId: string,
): Promise<boolean> {
  try {
    return (
      (await transient(
        ctx.env.PLATFORM_DB.prepare(COPY_KEY_LEFT_SQL).bind(installId).first(),
      )) !== null
    );
  } catch {
    return false;
  }
}

/**
 * Best effort, after an upgrade, rollback or mode change: with a left key
 * still open on the install (COPY_KEY_LEFT_SQL), a secret list without it is
 * recorded gone, which shuts the alert. Never fails the job it ends.
 */
export async function seeLeftKey(
  ctx: CreateCtx,
  jobId: string,
  installId: string,
): Promise<{ open: boolean; gone?: boolean }> {
  try {
    const open = await transient(
      ctx.env.PLATFORM_DB.prepare(COPY_KEY_LEFT_SQL).bind(installId).first(),
    );
    if (!open) return { open: false };
    const { target, script } = scriptTarget(ctx, installId);
    if ((await (await cfFor(ctx)).secretList(target, script)).includes(KEY))
      return { open: true, gone: false };
    await transient(
      auditStatement(ctx, installId, COPY_KEY_GONE_ACTION, {}, jobId).run(),
    );
    return { open: true, gone: true };
  } catch {
    return { open: true, gone: false };
  }
}

/** R30's steps. Everything after the put ends through dropCopyKey. */
export async function oauthCopy(
  ctx: CreateCtx,
  step: WorkflowStep,
  job: ManageJob,
  label: string,
): Promise<void> {
  const { jobId, installId } = job;
  await jobStep(ctx, step, jobId, "precheck", OAUTH_READ_STEP, () =>
    checkCopy(ctx, job, label),
  );
  let stopped: { e: unknown } | null = null;
  let keyUp = false;
  try {
    const { key } = await jobStep(
      ctx,
      step,
      jobId,
      "put_key",
      OAUTH_READ_STEP,
      async () => ({ key: await putKey(ctx, installId) }),
    );
    keyUp = true;
    await jobStep(ctx, step, jobId, "key_live", OAUTH_READ_STEP, () =>
      keyLive(ctx, job, key),
    );
    await copyAll(ctx, step, job, key);
  } catch (e) {
    // No lease in here, so no LostLease to keep: only step errors, kept to
    // rethrow once the key is off.
    stopped = { e };
  }
  // A put_key that failed may still land (an attempt that timed out).
  if (keyUp) await dropCopyKey(ctx, step, jobId, installId);
  else await dropCopyKeySettled(ctx, step, jobId, installId, ctx.io.now());
  if (stopped) throw stopped.e;
  await jobStep(ctx, step, jobId, "verify", OAUTH_READ_STEP, () =>
    verifyBackfilled(ctx, job),
  );
}
