// GitHub Actions OIDC verification (design v7 4.4), shared by the
// Provisioning API (staging red-line principal) and inventory (6.3).
// C4 ships the interface and a fail-closed stub; W5b builds the body: RS256
// only, `kid` from GitHub's JWKS (Cache API, 10 min; an unknown `kid`
// refetches at most once per 60 s per isolate; a fetch error fails closed),
// exp/nbf/iat with 60 s skew, `exp - iat <= 600`, and every pin below.

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
/** Fixed by 4.4 for every caller, so no caller can loosen them. */
export const GITHUB_OIDC_REF = "refs/heads/main";
export const GITHUB_OIDC_EVENT_NAMES = [
  "schedule",
  "workflow_dispatch",
] as const;

/** What a caller pins; every field must match the token exactly. */
export type Pins = {
  /** `aud` (OIDC_AUDIENCE). */
  audience: string;
  /** `repository` (OIDC_REPOSITORY), `owner/name`. */
  repository: string;
  /** `repository_id` (OIDC_REPOSITORY_ID), survives a rename. */
  repositoryId: string;
  /** `job_workflow_ref` must be one of these (OIDC_JOB_WORKFLOW_REFS). */
  jobWorkflowRefs: readonly string[];
  /** `environment` (OIDC_ENVIRONMENT), `redline-staging`. */
  environment: string;
};

/**
 * The verified claims; `iss`, `ref`, `event_name` and `runner_environment`
 * are the library constants above.
 */
export type Claims = {
  iss: typeof GITHUB_OIDC_ISSUER;
  aud: string;
  sub: string;
  iat: number;
  nbf: number;
  exp: number;
  repository: string;
  repository_id: string;
  ref: typeof GITHUB_OIDC_REF;
  job_workflow_ref: string;
  environment: string;
  event_name: (typeof GITHUB_OIDC_EVENT_NAMES)[number];
  runner_environment: "github-hosted";
};

/** Any failure; callers answer 401 and never echo `code` to the client. */
export class OidcError extends Error {
  constructor(readonly code: string) {
    super(`oidc: ${code}`);
    this.name = "OidcError";
  }
}

/** Verifies a GitHub Actions OIDC JWT against `pins`; rejects with OidcError. */
export async function verify(_jwt: string, _pins: Pins): Promise<Claims> {
  throw new OidcError("not_implemented");
}
