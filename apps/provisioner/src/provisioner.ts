// The provisioner's WfpProvisioner (design v7 2.5): the only place the
// Cloudflare token is read. The token is the Secrets Store secret
// oa-<p>-provision-token (PROVISION_TOKEN), held in memory for one step and
// never in a step output, error or log line. It must carry an end date at
// most PROVISIONER_MAX_TOKEN_DAYS out (the CLI keeps 30).
import { NonRetryableError } from "cloudflare:workflows";
import {
  bucketVersions,
  cfClient,
  type Env as DeployEnv,
  HOSTED_DOMAINS,
  NAMESPACES,
  PROVISIONER_MAX_TOKEN_DAYS,
  type R2CatalogBucket,
  r2BindingReleaseReader,
  type WfpOptions,
  WfpProvisioner,
} from "@oa/provision";

export interface ProvisionerEnv {
  PROVISION_TOKEN: SecretsStoreSecret;
  RELEASES: R2Bucket;
  ACCOUNT_ID: string;
  /** "staging" or "prod"; anything else is a terminal internal error. */
  OA_ENV: string;
}

/** The runtime's network and clock; the tests' run on fakes. */
export interface ProvisionerIo {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** The lease holder of a job (WfpOptions.leaseHolder, holderLease). */
export const jobHolder = (jobId: string): string => `job:${jobId}`;

/** The env, from OA_ENV; never guessed. */
export function deployEnv(v: string): DeployEnv {
  if (v !== "staging" && v !== "prod") throw new NonRetryableError("internal");
  return v;
}

/** A D1 or Secrets Store binding failed: retried, as `internal`. */
export class Transient extends Error {}
export const transient = async <T>(p: Promise<T>): Promise<T> => {
  try {
    return await p;
  } catch {
    throw new Transient("internal");
  }
};

/**
 * The options every job's WfpProvisioner runs with: the env's namespace and
 * domains, the release from the RELEASES binding, an owner token labelled
 * `label` (`ss-<signupId>`), /healthz required to report the install id,
 * and provision's audit rows written as `job:<jobId>` (4.9).
 * Turnstile, `onStep`, `brokerEnabled` and `directFetch` are the
 * Workflows' (W2, W3).
 */
export async function provisionerOptions(
  env: ProvisionerEnv,
  label: string,
  io: ProvisionerIo,
  jobId: string,
): Promise<WfpOptions> {
  const e = deployEnv(env.OA_ENV);
  const token = await transient(env.PROVISION_TOKEN.get());
  return {
    cf: cfClient({
      accountId: env.ACCOUNT_ID,
      token,
      fetch: io.fetch,
      sleep: io.sleep,
    }),
    env: e,
    target: { kind: "namespace", ns: NAMESPACES[e] },
    domains: HOSTED_DOMAINS[e],
    release: r2BindingReleaseReader(env.RELEASES, e),
    // #1343: an upgrade the DO rule refuses names the release to take first.
    releaseVersions: () =>
      bucketVersions(env.RELEASES as unknown as R2CatalogBucket),
    ciOwnerToken: { label },
    requireInstallId: true,
    maxTokenDays: PROVISIONER_MAX_TOKEN_DAYS,
    fetch: io.fetch,
    now: io.now,
    sleep: io.sleep,
    // 4.9: provision's own hosted_audit rows, as the job (auditAs).
    auditActor: `job:${jobId}`,
    // The job holds its leases: a retry of it re-enters one an earlier
    // attempt left (holderLease); any other job is still refused.
    leaseHolder: jobHolder(jobId),
  };
}

export async function provisionerFor(
  env: ProvisionerEnv,
  label: string,
  io: ProvisionerIo,
  jobId: string,
): Promise<WfpProvisioner> {
  return new WfpProvisioner(await provisionerOptions(env, label, io, jobId));
}
