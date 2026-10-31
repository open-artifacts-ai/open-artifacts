import { type Pins, type VerifyOptions, verify } from "@oa/gh-oidc";
import type { Env } from "../env.js";
import { type Principal, type Refusal, refusal } from "../principal.js";

// The GitHub OIDC principal (design v7 4.4, Q1): staging only, on the
// staging api host only, with every OIDC_* var set; prod refuses it here and
// again in authorize(). Any failure is 401 and never says why.

/** The one host that accepts an OIDC JWT. */
export const STAGING_API_HOST = "api.open-artifacts-staging.app";
/** `x-oa-test-user` turns the caller into a self-serve test user (M4). */
export const TEST_USER_HEADER = "x-oa-test-user";
const TEST_USERS = new Set(["a", "b", "c"]);
export const TEST_USER_DOMAIN = "test.invalid";

/** The caller's pins, or null unless staging and every OIDC_* var is set. */
export function oidcPins(env: Env): Pins | null {
  if (env.OA_ENV !== "staging") return null;
  const refs = (env.OIDC_JOB_WORKFLOW_REFS ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  const { OIDC_AUDIENCE, OIDC_REPOSITORY, OIDC_REPOSITORY_ID } = env;
  const { OIDC_ENVIRONMENT } = env;
  if (
    !OIDC_AUDIENCE ||
    !OIDC_REPOSITORY ||
    !OIDC_REPOSITORY_ID ||
    !OIDC_ENVIRONMENT ||
    refs.length === 0
  )
    return null;
  return {
    audience: OIDC_AUDIENCE,
    repository: OIDC_REPOSITORY,
    repositoryId: OIDC_REPOSITORY_ID,
    jobWorkflowRefs: refs,
    environment: OIDC_ENVIRONMENT,
  };
}

/** `opts` is a test seam for gh-oidc's JWKS fetch and clock. */
export async function oidcPrincipal(
  req: Request,
  env: Env,
  jwt: string,
  opts?: VerifyOptions,
): Promise<Principal | Refusal> {
  const pins = oidcPins(env);
  if (!pins || new URL(req.url).hostname.toLowerCase() !== STAGING_API_HOST)
    return refusal("unauthenticated");
  let claims: Awaited<ReturnType<typeof verify>>;
  try {
    claims = await verify(jwt, pins, opts);
  } catch {
    return refusal("unauthenticated");
  }
  const testUser = req.headers.get(TEST_USER_HEADER);
  if (testUser !== null) {
    if (!TEST_USERS.has(testUser)) return refusal("unauthenticated");
    const sub = `rl-test-${testUser}`;
    const email = `${sub}@${TEST_USER_DOMAIN}`;
    return {
      kind: "user",
      actorKey: `user:${sub}`,
      rateKey: `user:${sub}`,
      label: email,
      scopes: [],
      email,
      sub,
      hd: TEST_USER_DOMAIN,
      authAt: null,
    };
  }
  const key = `oidc:${claims.repository_id}`;
  return {
    kind: "oidc",
    actorKey: key,
    rateKey: key,
    label: claims.repository,
    scopes: [],
    sub: claims.sub,
    authAt: null,
  };
}
