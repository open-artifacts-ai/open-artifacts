// What both Workflows do around WfpProvisioner: the job's provisioner with
// its options (directFetch, onStep, the broker switch and the Turnstile pair
// derived like the CLI's), the owner token sweep, the live HOSTS mode a fail
// step reconciles install_lifecycle.serving_mode to, and the installs row.
import {
  type Cf,
  cfClient,
  codesOn,
  directFetch,
  googleNewlyEnabled,
  HOSTED_DOMAINS,
  hostsKvTitle,
  names,
  parseHostsValue,
  type WfpOptions,
  WfpProvisioner,
  type WfpStep,
} from "@oa/provision";
import type { ServingMode } from "@oa/shared/provisioning";
import {
  deployEnv,
  type ProvisionerEnv,
  type ProvisionerIo,
  provisionerOptions,
  transient,
} from "./provisioner.js";
import { markStep } from "./steps.js";
import { turnstilePair } from "./turnstile.js";

export interface OpsEnv extends ProvisionerEnv {
  PLATFORM_DB: D1Database;
  /** The install's script before any HOSTS mapping (5.2 f, directFetch). */
  DISPATCHER: DispatchNamespace;
}
export type OpsCtx = { env: OpsEnv; io: ProvisionerIo };

/** The installs row columns the Workflows read (never owner_email). */
export type InstallRowLite = {
  id: string;
  slug: string;
  app_host: string;
  content_host: string;
  state: string;
  version: string | null;
  previous_version: string | null;
  test_hooks: number;
  vars: string | null;
  lease: string | null;
  lease_until: number | null;
};

export async function installRow(
  ctx: OpsCtx,
  id: string,
): Promise<InstallRowLite | null> {
  return transient(
    ctx.env.PLATFORM_DB.prepare(
      "SELECT id, slug, app_host, content_host, state, version, previous_version, test_hooks, vars, lease, lease_until FROM installs WHERE id = ?",
    )
      .bind(id)
      .first<InstallRowLite>(),
  );
}

/** The app host an install of `slug` gets in this env. */
export const appHostOf = (env: OpsEnv, slug: string): string =>
  `${slug}.${HOSTED_DOMAINS[deployEnv(env.OA_ENV)].app}`;

/**
 * The job's WfpProvisioner: owner token `ss-<signupId>` (or the job id's
 * label when the job has no signup), plus `extra`.
 */
export async function provisionerWith(
  ctx: OpsCtx,
  label: string,
  jobId: string,
  extra: Partial<WfpOptions> = {},
): Promise<WfpProvisioner> {
  const o = await provisionerOptions(ctx.env, label, ctx.io, jobId);
  return new WfpProvisioner({ ...o, ...extra });
}

/**
 * The rendering options of a create, upgrade or rollback (5.3, 5.4): the
 * install's script through DISPATCHER only, each WFP_STEPS step written to
 * the job, `brokerEnabled = googleNewlyEnabled({}, vars)`, and the widget
 * pair whenever codes are on (a test-hooks install gets provision's test
 * pair instead).
 */
export async function renderOptions(
  ctx: OpsCtx,
  o: {
    jobId: string;
    label: string;
    installId: string;
    appHost: string;
    vars: Record<string, string>;
    testHooks: boolean;
    registryDisabled?: boolean;
    /**
     * upgrade, rollback: the lease the operation claimed, read at the first
     * step report (5.4 fail). Run-local: jobs.args stays the request (8.3).
     */
    onClaim?: (lease: string | null) => void;
    /**
     * upgrade, rollback: the health report, sent only once verify_clean
     * passed on what serves. Run-local, like onClaim.
     */
    onVerified?: () => void;
  },
): Promise<WfpProvisioner> {
  const e = deployEnv(ctx.env.OA_ENV);
  const base = await provisionerOptions(ctx.env, o.label, ctx.io, o.jobId);
  const turnstile =
    codesOn(o.vars) && !o.testHooks
      ? await turnstilePair(base.cf, e)
      : undefined;
  let claimed = false;
  return new WfpProvisioner({
    ...base,
    fetch: directFetch(ctx.env.DISPATCHER, {
      appHost: o.appHost,
      script: names(o.installId, e).script,
    }),
    onStep: async (s: WfpStep) => {
      // The first report comes right after the claim: the lease is ours.
      if (o.onClaim && !claimed) {
        claimed = true;
        o.onClaim((await installRow(ctx, o.installId))?.lease ?? null);
      }
      await markStep(ctx, o.jobId, s);
      if (s === "health") o.onVerified?.();
    },
    brokerEnabled: googleNewlyEnabled({}, o.vars),
    ...(turnstile ? { turnstile } : {}),
    ...(o.registryDisabled ? { registryDisabled: true } : {}),
  });
}

/** The stored vars of an install (installs.vars), as strings. */
export function storedVars(raw: string | null): Record<string, string> {
  if (raw === null) return {};
  const v = JSON.parse(raw) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(v).filter(
      (x): x is [string, string] => typeof x[1] === "string",
    ),
  );
}

/** Revokes the install's active `label` owner tokens; none before it exists. */
export async function sweepTokens(
  ctx: OpsCtx,
  label: string,
  installId: string,
  jobId: string,
): Promise<{ revoked: number }> {
  if (!(await installRow(ctx, installId))) return { revoked: 0 };
  const p = await provisionerWith(ctx, label, jobId);
  const { revoked } = await p.ciTokenSweep(installId, label);
  return { revoked };
}

/** A Cloudflare client on PROVISION_TOKEN, for reads outside an operation. */
export async function cfFor(ctx: OpsCtx): Promise<Cf> {
  deployEnv(ctx.env.OA_ENV);
  const token = await transient(ctx.env.PROVISION_TOKEN.get());
  return cfClient({
    accountId: ctx.env.ACCOUNT_ID,
    token,
    fetch: ctx.io.fetch,
    sleep: ctx.io.sleep,
  });
}

/** What dispatch serves for the install now (its app host's HOSTS value). */
export async function liveMode(
  ctx: OpsCtx,
  row: InstallRowLite,
): Promise<ServingMode> {
  const e = deployEnv(ctx.env.OA_ENV);
  const cf = await cfFor(ctx);
  const kv = await cf.kvFind(hostsKvTitle(e));
  if (!kv) return "unmapped";
  for (const h of [row.app_host, row.content_host]) {
    const v = parseHostsValue(await cf.kvGet(kv, h));
    if (v?.installId === row.id) return v.mode;
  }
  return "unmapped";
}

/** install_lifecycle.serving_mode, as the provisioner last wrote HOSTS. */
export function modeStatement(
  ctx: OpsCtx,
  installId: string,
  mode: ServingMode,
): D1PreparedStatement {
  return ctx.env.PLATFORM_DB.prepare(
    "UPDATE install_lifecycle SET serving_mode = ?2, updated_at = ?3 WHERE install_id = ?1",
  ).bind(installId, mode, ctx.io.now());
}

/**
 * A fail step's reconcile (5.5): the lifecycle's serving_mode set to the
 * live HOSTS mode, so D1 never shows less exposure than dispatch serves.
 * No installs row: nothing was ever routed. A Cloudflare error leaves it.
 */
export async function reconcile(
  ctx: OpsCtx,
  installId: string,
): Promise<D1PreparedStatement[]> {
  const row = await installRow(ctx, installId);
  if (!row) return [];
  try {
    return [modeStatement(ctx, installId, await liveMode(ctx, row))];
  } catch {
    return [];
  }
}
