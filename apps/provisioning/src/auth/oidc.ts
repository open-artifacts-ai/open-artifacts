import {
  type Pins,
  pinsFromEnv,
  type VerifyOptions,
  verify,
} from "@oa/gh-oidc";
import { type OidcWorkflow, TEST_MEMBER } from "@oa/shared/provisioning";
import type { Env } from "../env.js";
import { type Principal, type Refusal, refusal } from "../principal.js";

// The GitHub OIDC principal (design v7 4.4, Q1): staging only, on the
// staging api host only, with every OIDC_* var set (pinsFromEnv). Prod
// refuses it here, before any JWKS fetch, for the oidc kind and an
// `x-oa-test-user` caller alike; authorize() refuses kind oidc again. Any
// failure is 401 and never says why.

/** The one host that accepts an OIDC JWT. */
export const STAGING_API_HOST = "api.open-artifacts-staging.app";
/** `x-oa-test-user` turns the caller into a self-serve test user (M4). */
export const TEST_USER_HEADER = "x-oa-test-user";
const TEST_USERS = new Set(["a", "b", "c"]);
export const TEST_USER_DOMAIN = "test.invalid";
/**
 * The one workflow whose JWT mints the staging test admin's session (R28,
 * #1053). It must also be in OIDC_JOB_WORKFLOW_REFS; its caller may call R28
 * and nothing else, and no other caller may call R28 (authorize).
 */
export const TEST_ADMIN_WORKFLOW_REF =
  "open-artifacts-ai/open-artifacts/.github/workflows/staging-test-admin.yml@refs/heads/main";

/**
 * The one workflow whose JWT may take the staging test member's credentials
 * (R26 on `rl-agents` only, then R15 and R2: TEST_MEMBER in authz). It must
 * also be in OIDC_JOB_WORKFLOW_REFS; it is never a test user, and its jobs
 * and sealed results are its own (actorKey `oidc:<repository_id>:test-member`).
 */
export const TEST_MEMBER_WORKFLOW_REF =
  "open-artifacts-ai/open-artifacts/.github/workflows/staging-test-member.yml@refs/heads/main";

/** Red-line's workflow (redline-staging.yml): the rl- test installs' scope. */
export const REDLINE_WORKFLOW_REF =
  "open-artifacts-ai/open-artifacts/.github/workflows/redline-staging.yml@refs/heads/main";

/**
 * Each pinned workflow's scope. A JWT whose job_workflow_ref is in
 * OIDC_JOB_WORKFLOW_REFS but not here is refused (401): no ref falls back to
 * red-line's scope.
 */
const WORKFLOW_SCOPES: ReadonlyMap<string, OidcWorkflow> = new Map([
  [REDLINE_WORKFLOW_REF, "redline"],
  [TEST_ADMIN_WORKFLOW_REF, "test-admin"],
  [TEST_MEMBER_WORKFLOW_REF, "test-member"],
]);

/** The caller's pins, or null unless staging and every OIDC_* var is set. */
export function oidcPins(env: Env): Pins | null {
  return env.OA_ENV === "staging" ? pinsFromEnv(env) : null;
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
  const workflow = WORKFLOW_SCOPES.get(claims.job_workflow_ref);
  if (workflow === undefined) return refusal("unauthenticated");
  const testAdmin = workflow === "test-admin";
  const testMember = workflow === "test-member";
  const testUser = req.headers.get(TEST_USER_HEADER);
  if (testUser !== null) {
    // The test admin's and test member's workflows are never a test user.
    if (testAdmin || testMember) return refusal("unauthenticated");
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
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  // The test member's own key: its R26 jobs (and their sealed results, R15)
  // are never red-line's, and red-line's never its.
  const memberKey = `${key}${TEST_MEMBER.actorSuffix}`;
  return {
    kind: "oidc",
    actorKey: testMember ? memberKey : key,
    // Its own bucket: R28 and red-line never starve each other.
    rateKey: testAdmin ? `${key}:test-admin` : testMember ? memberKey : key,
    label: claims.repository,
    scopes: [],
    sub: claims.sub,
    authAt: null,
    oidcWorkflow: workflow,
    ...(testAdmin
      ? {
          oidcRun: {
            actor: str(claims.actor),
            runId: str(claims.run_id),
            workflowRef: claims.job_workflow_ref,
          },
        }
      : {}),
  };
}
