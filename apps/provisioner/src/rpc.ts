// ProvisionerRpc (design v7 2.6): the only RPC surface. Workers RPC exposes
// every public method of a WorkerEntrypoint and TS `private` is not enforced
// at runtime, so the class has exactly three methods, each delegating to a
// module function; no helpers on the class. No method returns a token field.
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  bucketPublishedAt,
  bucketVersions,
  CfError,
  cfClient,
  type R2CatalogBucket,
  r2BindingReleaseReader,
  releaseCatalog,
  TURNSTILE_TEST_KEYS,
} from "@oa/provision";
import {
  type ProvisionerRpc as ProvisionerRpcContract,
  type Release,
  TOKEN_EXPIRING_DAYS,
  type TokenStatus,
  type VerifyTurnstileInput,
} from "@oa/shared/provisioning";
import {
  deployEnv,
  type ProvisionerEnv,
  type ProvisionerIo,
  transient,
} from "./provisioner.js";
import { siteverify, turnstilePair } from "./turnstile.js";

/** The releases bucket, the token, the env (Turnstile widget GET over REST). */
export type RpcEnv = ProvisionerEnv;

const DAY_MS = 86_400_000;
const IO: ProvisionerIo = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** The release catalog of RELEASES (signed records, floor), newest first. */
export async function listReleases(env: RpcEnv): Promise<Release[]> {
  const e = deployEnv(env.OA_ENV);
  const bucket = env.RELEASES as unknown as R2CatalogBucket;
  return releaseCatalog({
    release: r2BindingReleaseReader(bucket, e),
    env: e,
    versions: await bucketVersions(bucket),
    publishedAt: bucketPublishedAt(bucket),
  });
}

async function cfOf(env: RpcEnv, io: ProvisionerIo) {
  const token = await transient(env.PROVISION_TOKEN.get());
  return cfClient({
    accountId: env.ACCOUNT_ID,
    token,
    fetch: io.fetch,
    sleep: io.sleep,
  });
}

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const IP = /^[0-9A-Fa-f:.]{2,45}$/;

/**
 * Siteverify against widget oa-<p>-turnstile's secret; `testUser` uses
 * Turnstile's always-pass test secret, only when OA_ENV is "staging" (on
 * prod the flag is ignored and the widget secret is used).
 */
export async function verifyTurnstileToken(
  env: RpcEnv,
  i: VerifyTurnstileInput,
  io: ProvisionerIo = IO,
): Promise<{ ok: boolean }> {
  const e = deployEnv(env.OA_ENV);
  if (
    typeof i?.token !== "string" ||
    i.token === "" ||
    i.token.length > 2048 ||
    i.action !== "signup" ||
    typeof i.hostname !== "string" ||
    !HOST.test(i.hostname) ||
    typeof i.remoteIp !== "string" ||
    !IP.test(i.remoteIp)
  )
    return { ok: false };
  const secret =
    i.testUser === true && e === "staging"
      ? TURNSTILE_TEST_KEYS.secret
      : (await turnstilePair(await cfOf(env, io), e)).secret;
  const ok = await siteverify(io.fetch, {
    secret,
    token: i.token,
    remoteIp: i.remoteIp,
    action: i.action,
    hostname: i.hostname,
  });
  return { ok };
}

/**
 * PROVISION_TOKEN's status and end date (`/user/tokens/verify`): `invalid`
 * when Cloudflare refuses it, it is not active, or it has no end date or is
 * past it; `expiring` within TOKEN_EXPIRING_DAYS. A network or 5xx error
 * throws (the caller caches the last answer).
 */
export async function provisionTokenStatus(
  env: RpcEnv,
  io: ProvisionerIo = IO,
): Promise<TokenStatus> {
  deployEnv(env.OA_ENV);
  const invalid: TokenStatus = {
    status: "invalid",
    expiresAt: null,
    daysLeft: null,
  };
  let info: { status?: unknown; expires_on?: unknown };
  try {
    info = (await (await cfOf(env, io)).tokenVerify()) as typeof info;
  } catch (e) {
    if (e instanceof CfError && e.status >= 400 && e.status < 500)
      return invalid;
    throw new Error("internal");
  }
  const exp =
    typeof info.expires_on === "string" ? Date.parse(info.expires_on) : NaN;
  const now = io.now();
  if (info.status !== "active" || !Number.isFinite(exp) || exp <= now)
    return invalid;
  const daysLeft = Math.floor((exp - now) / DAY_MS);
  return {
    status: daysLeft <= TOKEN_EXPIRING_DAYS ? "expiring" : "active",
    expiresAt: exp,
    daysLeft,
  };
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
