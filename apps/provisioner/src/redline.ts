// redline_creds (design v7 10.1, R26; staging, rl- test installs only): the
// red-line suite's credentials for one run, sealed to the caller's
// ephemeral X25519 key into jobs.sealed. TEST_HOOK_KEY is rotated (a secret
// PUT), a session for the suite's admin test user is opened through
// DISPATCHER (POST /__test/session, as the laptop command did), every older
// redline-* PAT is revoked and one labelled redline-<jobId> is minted, then
// {pat, hookKey} is sealed. The three steps run in one step.do, so no
// credential is ever a step output; D1 holds only the ciphertext, and no
// log line, error or audit row carries a value.
import type { WorkflowStep } from "cloudflare:workers";
import {
  directFetch,
  NAMESPACES,
  names,
  newSecret,
  ProvisionRefused,
  STAGING_TEST_DOMAIN,
} from "@oa/provision";
import type { ManageJob } from "./manage.js";
import { cfFor, installRow, storedVars } from "./ops.js";
import { deployEnv, transient } from "./provisioner.js";
import { sealTo } from "./seal.js";
import { argsOf, jobStep, markStep, readJob } from "./steps.js";
import type { CreateCtx } from "./workflow.js";

/** The PAT label prefix the suite's tokens carry (scripts/hosted redline-creds). */
export const REDLINE_LABEL_PREFIX = "redline-";
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

export async function redlineCreds(
  ctx: CreateCtx,
  step: WorkflowStep,
  jobId: string,
  job: ManageJob,
): Promise<void> {
  await jobStep(ctx, step, jobId, "rotate_hook_key", REDLINE_STEP, () =>
    rotateMintSeal(ctx, jobId, job),
  );
}

async function rotateMintSeal(
  ctx: CreateCtx,
  jobId: string,
  job: ManageJob,
): Promise<{ sealed: true }> {
  const e = deployEnv(ctx.env.OA_ENV);
  if (e !== "staging")
    throw new ProvisionRefused(
      "redline_creds is staging only",
      "invalid_state",
    );
  const j = await readJob(ctx, jobId);
  const recipientKey = j ? argsOf(j).recipientKey : undefined;
  if (
    typeof recipientKey !== "string" ||
    !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(recipientKey)
  )
    throw new ProvisionRefused("no recipient key", "invalid_state");
  const row = await installRow(ctx, job.installId);
  if (!row || row.state !== "active" || row.test_hooks !== 1)
    throw new ProvisionRefused(
      "not an active test-hooks install",
      "invalid_state",
    );
  const testDomain = storedVars(row.vars).TEST_DOMAIN;
  if (testDomain !== STAGING_TEST_DOMAIN)
    throw new ProvisionRefused(
      "the install has no TEST_DOMAIN",
      "invalid_state",
    );
  const script = names(row.id, e).script;
  const app = `https://${row.app_host}`;
  const f = directFetch(ctx.env.DISPATCHER, { appHost: row.app_host, script });

  // rotate_hook_key: a fresh key, live on the script before it is used.
  const hookKey = newSecret();
  const cf = await cfFor(ctx);
  await cf.secretPut(
    { kind: "namespace", ns: NAMESPACES[e] },
    script,
    "TEST_HOOK_KEY",
    hookKey,
  );

  // mint: a session for the suite's admin test user, then one PAT.
  await markStep(ctx, jobId, "mint");
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
  const l = await call(
    f,
    `${app}/api/v1/tokens`,
    asAdmin(),
    "list tokens",
    [200],
  );
  const listed = (await l.json().catch(() => null)) as unknown;
  if (!Array.isArray(listed)) throw new Error("list tokens: not a list");
  for (const t of listed)
    if (
      typeof t?.id === "string" &&
      typeof t?.label === "string" &&
      t.label.startsWith(REDLINE_LABEL_PREFIX)
    )
      await call(
        f,
        `${app}/api/v1/tokens/${encodeURIComponent(t.id)}`,
        asAdmin({ method: "DELETE" }),
        "revoke an earlier token",
        [204, 404],
      );
  const m = await call(
    f,
    `${app}/api/v1/tokens`,
    asAdmin({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: `${REDLINE_LABEL_PREFIX}${jobId}` }),
    }),
    "mint token",
    [201],
  );
  const pat = ((await m.json().catch(() => null)) as { token?: unknown })
    ?.token;
  if (typeof pat !== "string" || !pat.startsWith("oa_pat_"))
    throw new Error("mint token: no token");
  await call(
    f,
    `${app}/api/v1/me`,
    { headers: { authorization: `Bearer ${pat}` } },
    "new token check",
    [200],
  );

  // seal: only the ciphertext reaches D1, and only while the job is open.
  await markStep(ctx, jobId, "seal");
  const sealed = await sealTo(recipientKey, JSON.stringify({ pat, hookKey }));
  await transient(
    ctx.env.PLATFORM_DB.prepare(
      "UPDATE jobs SET sealed = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'running'",
    )
      .bind(jobId, sealed, ctx.io.now())
      .run(),
  );
  return { sealed: true };
}
