// The provisioner's WfpProvisioner (design v7 2.5): the only place the
// Cloudflare token is read. The token is the Secrets Store secret
// oa-<p>-provision-token (PROVISION_TOKEN), held in memory for one step and
// never in a step output, error or log line. It must carry an end date at
// most PROVISIONER_MAX_TOKEN_DAYS out (the CLI keeps 30).
import { NonRetryableError } from "cloudflare:workflows";
import {
  cfClient,
  type Env as DeployEnv,
  HOSTED_DOMAINS,
  NAMESPACES,
  PROVISIONER_MAX_TOKEN_DAYS,
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
 * `label` (`ss-<signupId>`), /healthz required to report the install id.
 * Turnstile, `onStep`, `brokerEnabled` and `directFetch` are the
 * Workflows' (W2, W3).
 */
export async function provisionerOptions(
  env: ProvisionerEnv,
  label: string,
  io: ProvisionerIo,
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
    ciOwnerToken: { label },
    requireInstallId: true,
    maxTokenDays: PROVISIONER_MAX_TOKEN_DAYS,
    fetch: io.fetch,
    now: io.now,
    sleep: io.sleep,
  };
}

export async function provisionerFor(
  env: ProvisionerEnv,
  label: string,
  io: ProvisionerIo,
): Promise<WfpProvisioner> {
  return new WfpProvisioner(await provisionerOptions(env, label, io));
}
