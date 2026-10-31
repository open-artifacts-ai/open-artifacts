// ProvisionerRpc (design v7 2.6): the only RPC surface. Workers RPC exposes
// every public method of a WorkerEntrypoint and TS `private` is not enforced
// at runtime, so the class has exactly three methods, each delegating to a
// module function; no helpers on the class. No method returns a token field.
import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  ProvisionerRpc as ProvisionerRpcContract,
  Release,
  TokenStatus,
  VerifyTurnstileInput,
} from "@oa/shared/provisioning";
import type { ProvisionerEnv } from "./provisioner.js";
import { notBuilt } from "./stub.js";

/** The releases bucket, the token, the env (Turnstile widget GET over REST). */
export type RpcEnv = ProvisionerEnv;

/** The installable releases from RELEASES (signed records, floor). W3. */
export async function listReleases(env: RpcEnv): Promise<Release[]> {
  void env;
  throw notBuilt("releases");
}

/**
 * Siteverify against widget oa-<p>-turnstile's secret; `testUser` uses
 * Turnstile's always-pass test secret, only when OA_ENV is "staging". W3.
 */
export async function verifyTurnstileToken(
  env: RpcEnv,
  i: VerifyTurnstileInput,
): Promise<{ ok: boolean }> {
  void env;
  void i;
  throw notBuilt("verifyTurnstile");
}

/** PROVISION_TOKEN's status and end date (`/user/tokens/verify`). W3. */
export async function provisionTokenStatus(env: RpcEnv): Promise<TokenStatus> {
  void env;
  throw notBuilt("tokenStatus");
}

export class ProvisionerRpc
  extends WorkerEntrypoint<RpcEnv>
  implements ProvisionerRpcContract
{
  releases(): Promise<Release[]> {
    return listReleases(this.env);
  }

  verifyTurnstile(i: VerifyTurnstileInput): Promise<{ ok: boolean }> {
    return verifyTurnstileToken(this.env, i);
  }

  tokenStatus(): Promise<TokenStatus> {
    return provisionTokenStatus(this.env);
  }
}
