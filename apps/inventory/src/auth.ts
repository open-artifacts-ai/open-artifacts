import type { Claims, Pins } from "@oa/gh-oidc";
import { notFound, unavailable } from "./http.ts";

// Every route takes a GitHub Actions OIDC bearer (design v7 6.3, 4.4),
// verified by @oa/gh-oidc against the five OIDC_* vars. A missing or empty
// var fails closed before the header is read (503); every auth failure is the
// unknown-route 404, byte for byte, so a caller without a valid token can't
// tell the Worker or its routes exist (hosted.md, Inventory).

export type Verify = (jwt: string, pins: Pins) => Promise<Claims>;

export interface OidcVars {
  OIDC_AUDIENCE?: string;
  OIDC_REPOSITORY?: string;
  OIDC_REPOSITORY_ID?: string;
  /** Comma list of `owner/repo/.github/workflows/<file>@refs/heads/main`. */
  OIDC_JOB_WORKFLOW_REFS?: string;
  OIDC_ENVIRONMENT?: string;
}

/** A JWT is a few KB; anything longer is refused before the verifier. */
const MAX_BEARER = 8192;

const nonEmpty = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

// TODO(contract): @oa/gh-oidc has no shared pinsFromEnv; provisioning needs
// the same parser.
/** The pins from the five vars, or null when any is missing or empty. */
export function pinsFromEnv(env: OidcVars): Pins | null {
  const audience = nonEmpty(env.OIDC_AUDIENCE);
  const repository = nonEmpty(env.OIDC_REPOSITORY);
  const repositoryId = nonEmpty(env.OIDC_REPOSITORY_ID);
  const environment = nonEmpty(env.OIDC_ENVIRONMENT);
  const jobWorkflowRefs = (env.OIDC_JOB_WORKFLOW_REFS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (
    !audience ||
    !repository ||
    !repositoryId ||
    !environment ||
    jobWorkflowRefs.length === 0
  )
    return null;
  return { audience, repository, repositoryId, jobWorkflowRefs, environment };
}

export type Authed = { claims: Claims; pins: Pins };

/** The verified claims and pins, or the fixed 503 / plain 404 to answer. */
export async function authenticate(
  request: Request,
  env: OidcVars,
  verify: Verify,
): Promise<Authed | Response> {
  const pins = pinsFromEnv(env);
  if (!pins) return unavailable();
  const m = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "");
  if (!m?.[1] || m[1].length > MAX_BEARER) return notFound();
  try {
    return { claims: await verify(m[1], pins), pins };
  } catch {
    // OidcError or not: the same 404, never its code or message.
    return notFound();
  }
}
