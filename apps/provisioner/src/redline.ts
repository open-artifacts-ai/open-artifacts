// redline_creds (design v7 10.1, R26; staging, rl- test installs only): the
// red-line suite's credentials for one run, sealed to the caller's
// ephemeral X25519 key into jobs.sealed. args is C6's RedlineCredsSchema
// (absent `revoke` is a mint); the steps are jobStepsFor(kind, args).
// Mint: TEST_HOOK_KEY is rotated (a secret PUT), a session for the suite's
// admin test user is opened through DISPATCHER (POST /__test/session, as
// the laptop command did), one PAT labelled redline-<jobId> is minted, every
// other live redline-* PAT of this install is revoked (redlinePatsToRevoke,
// keep = the new one), then {pat, hookKey} is sealed; a job closed by then
// (the seal matches no row) gets `sealed: false` and the new PAT revoked. Revoke (`revoke:
// true`, the run's end): the same session (so TEST_HOOK_KEY is rotated too,
// to a key delivered to nobody), then every live redline-* PAT of this
// install is revoked; nothing is minted or sealed, so the run's end kills
// both its PAT and its hook key. A repeat rotates again and is a harmless
// `done`. The provisioning token is checked first
// in `refuse` mode (5.7). Each variant runs in one step.do, so no
// credential is ever a step output; D1 holds only the ciphertext, and no
// log line, error or audit row carries a value.
import type { WorkflowStep } from "cloudflare:workers";
import {
  directFetch,
  NAMESPACES,
  names,
  newSecret,
  ProvisionRefused,
  REDLINE_TEST_DOMAINS,
} from "@oa/provision";
import {
  type JobKind,
  jobStepsFor,
  REDLINE_PAT_PREFIX,
  type RedlineCreds,
  RedlineCredsSchema,
  type RedlinePat,
  redlinePatsToRevoke,
} from "@oa/shared/provisioning";
import type { ManageJob } from "./manage.js";
import { cfFor, installRow, provisionerWith, storedVars } from "./ops.js";
import { deployEnv, transient } from "./provisioner.js";
import { refused } from "./recheck.js";
import { sealTo } from "./seal.js";
import { argsOf, type JobRow, jobStep, markStep, readJob } from "./steps.js";
import type { CreateCtx } from "./workflow.js";

/** The install's session cookie on a hosted install. */
const SESSION_COOKIE = "__Host-oa_session";
/** The rotate, mint and seal attempt: the key is rotated again on a retry. */
export const REDLINE_STEP = {
  retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} as const;

/** Only the status: a body can carry the install's own error text. */
async function call(
  f: typeof fetch,
  url: string,
  init: RequestInit,
  what: string,
  want: number[],
): Promise<Response> {
  const res = await f(url, { ...init, redirect: "manual" });
  if (!want.includes(res.status)) {
    await res.body?.cancel();
    throw new Error(`${what}: HTTP ${res.status}`);
  }
  return res;
}

/**
 * The job's R26 body: C6's RedlineCredsSchema over jobs.args, with the
 * row's request id. A body that does not parse is refused (invalid_state,
 * terminal).
 */
export function redlineArgs(job: JobRow): RedlineCreds {
  const r = RedlineCredsSchema.safeParse({
    ...argsOf(job),
    requestId: job.request_id,
  });
  if (!r.success) throw refused("the redline_creds args do not parse");
  return r.data;
}

export async function redlineCreds(
  ctx: CreateCtx,
  step: WorkflowStep,
  jobId: string,
  job: ManageJob,
): Promise<void> {
  const kind: JobKind = "redline_creds";
  const steps = jobStepsFor(kind, job.args);
  if (steps.includes("revoke"))
    await jobStep(ctx, step, jobId, "revoke", REDLINE_STEP, () =>
      revokeAll(ctx, jobId, job),
    );
  else
    await jobStep(ctx, step, jobId, "rotate_hook_key", REDLINE_STEP, () =>
      rotateMintSeal(ctx, jobId, job),
    );
}

type Session = {
  f: typeof fetch;
  app: string;
  installId: string;
  hookKey: string;
  asAdmin: (init?: RequestInit) => RequestInit;
};

/**
 * The checks, the token check (`refuse`), a fresh TEST_HOOK_KEY live on
 * the script, and a session for the suite's admin test user.
 */
async function openSession(
  ctx: CreateCtx,
  jobId: string,
  job: ManageJob,
): Promise<Session> {
  const e = deployEnv(ctx.env.OA_ENV);
  if (e !== "staging")
    throw new ProvisionRefused(
      "redline_creds is staging only",
      "invalid_state",
    );
  const row = await installRow(ctx, job.installId);
  if (!row || row.state !== "active" || row.test_hooks !== 1)
    throw new ProvisionRefused(
      "not an active test-hooks install",
      "invalid_state",
    );
  const testDomain = storedVars(row.vars).TEST_DOMAIN;
  if (
    typeof testDomain !== "string" ||
    !REDLINE_TEST_DOMAINS.includes(testDomain)
  )
    throw new ProvisionRefused(
      "the install has no TEST_DOMAIN",
      "invalid_state",
    );
  const script = names(row.id, e).script;
  const app = `https://${row.app_host}`;
  const f = directFetch(ctx.env.DISPATCHER, { appHost: row.app_host, script });

  // 5.7: redline_creds refuses a near-expiry token, before any write.
  await (
    await provisionerWith(ctx, `ss-${job.signupId ?? jobId}`, jobId)
  ).verifyToken("refuse");

  // rotate_hook_key: a fresh key, live on the script before it is used.
  const hookKey = newSecret();
  const cf = await cfFor(ctx);
  await cf.secretPut(
    { kind: "namespace", ns: NAMESPACES[e] },
    script,
    "TEST_HOOK_KEY",
    hookKey,
  );

  const s = await call(
    f,
    `${app}/__test/session`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${hookKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: `redline-admin@${testDomain}`,
        role: "admin",
      }),
    },
    "test session",
    [200],
  );
  const cookie = ((await s.json().catch(() => null)) as { cookie?: unknown })
    ?.cookie;
  if (typeof cookie !== "string" || cookie === "")
    throw new Error("test session: no cookie");
  const asAdmin = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      cookie: `${SESSION_COOKIE}=${cookie}`,
      "x-oa-request": "1",
    },
  });
  return { f, app, installId: row.id, hookKey, asAdmin };
}

/** The install's live PATs, as RedlinePat rows of this install only. */
async function listPats(s: Session): Promise<RedlinePat[]> {
  const l = await call(
    s.f,
    `${s.app}/api/v1/tokens`,
    s.asAdmin(),
    "list tokens",
    [200],
  );
  const listed = (await l.json().catch(() => null)) as unknown;
  if (!Array.isArray(listed)) throw new Error("list tokens: not a list");
  return listed
    .filter(
      (t): t is { id: string; label: string; revokedAt?: unknown } =>
        typeof t?.id === "string" && typeof t?.label === "string",
    )
    .map((t) => ({
      id: t.id,
      installId: s.installId,
      label: t.label,
      revokedAt: typeof t.revokedAt === "number" ? t.revokedAt : null,
    }));
}

/** Revokes this install's live redline-* PATs but `keep`; the count. */
async function revokeRedline(s: Session, keep?: string): Promise<number> {
  const ids = redlinePatsToRevoke(
    s.installId,
    await listPats(s),
    keep === undefined ? undefined : { keep },
  );
  for (const id of ids)
    await call(
      s.f,
      `${s.app}/api/v1/tokens/${encodeURIComponent(id)}`,
      s.asAdmin({ method: "DELETE" }),
      "revoke a redline token",
      [204, 404],
    );
  return ids.length;
}

/**
 * R26 `revoke: true`: mints and seals nothing; none left revokes nothing.
 * openSession rotates TEST_HOOK_KEY to a key no one is given, which ends the
 * run's hook key with its PAT. Red-line runs on one install never overlap
 * (one suite per rl- install), so this rotation cannot cut off another run.
 */
async function revokeAll(
  ctx: CreateCtx,
  jobId: string,
  job: ManageJob,
): Promise<{ revoked: number }> {
  const s = await openSession(ctx, jobId, job);
  return { revoked: await revokeRedline(s) };
}

async function rotateMintSeal(
  ctx: CreateCtx,
  jobId: string,
  job: ManageJob,
): Promise<{ sealed: boolean }> {
  const j = await readJob(ctx, jobId);
  if (!j) throw refused("no job row");
  const args = redlineArgs(j);
  if (args.revoke !== false) throw refused("not a mint");
  const { recipientKey } = args;
  const s = await openSession(ctx, jobId, job);

  // mint: one PAT, then every other live redline-* PAT of this install.
  await markStep(ctx, jobId, "mint");
  const m = await call(
    s.f,
    `${s.app}/api/v1/tokens`,
    s.asAdmin({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: `${REDLINE_PAT_PREFIX}${jobId}` }),
    }),
    "mint token",
    [201],
  );
  const minted = (await m.json().catch(() => null)) as {
    id?: unknown;
    token?: unknown;
  } | null;
  const pat = minted?.token;
  if (typeof pat !== "string" || !pat.startsWith("oa_pat_"))
    throw new Error("mint token: no token");
  if (typeof minted?.id !== "string" || minted.id === "")
    throw new Error("mint token: no id");
  await call(
    s.f,
    `${s.app}/api/v1/me`,
    { headers: { authorization: `Bearer ${pat}` } },
    "new token check",
    [200],
  );
  await revokeRedline(s, minted.id);

  // seal: only the ciphertext reaches D1, and only while the job is open.
  await markStep(ctx, jobId, "seal");
  const sealed = await sealTo(
    recipientKey,
    JSON.stringify({ pat, hookKey: s.hookKey }),
  );
  const r = await transient(
    ctx.env.PLATFORM_DB.prepare(
      "UPDATE jobs SET sealed = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'running'",
    )
      .bind(jobId, sealed, ctx.io.now())
      .run(),
  );
  if ((r.meta.changes ?? 0) > 0) return { sealed: true };
  // The job closed under us (an R25 cancel, the sweep): no one can read the
  // PAT, so it is revoked here, before the step ends, never left live.
  await call(
    s.f,
    `${s.app}/api/v1/tokens/${encodeURIComponent(minted.id)}`,
    s.asAdmin({ method: "DELETE" }),
    "revoke the unsealed token",
    [204, 404],
  );
  return { sealed: false };
}
