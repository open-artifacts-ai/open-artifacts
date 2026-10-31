import { describe, expect, it } from "vitest";
import {
  type Claims,
  GITHUB_OIDC_EVENT_NAMES,
  GITHUB_OIDC_ISSUER,
  GITHUB_OIDC_REF,
  OidcError,
  type Pins,
  verify,
} from "../src/index.js";

const pins: Pins = {
  audience: "https://api.open-artifacts-staging.app",
  repository: "open-artifacts-ai/open-artifacts",
  repositoryId: "1",
  jobWorkflowRefs: [
    "open-artifacts-ai/open-artifacts/.github/workflows/redline-staging.yml@refs/heads/main",
  ],
  environment: "redline-staging",
};

describe("verify (C4 stub)", () => {
  it("pins GitHub's issuer", () => {
    expect(GITHUB_OIDC_ISSUER).toBe(
      "https://token.actions.githubusercontent.com",
    );
  });

  it("fixes ref and event_name in the library, not the caller (4.4)", () => {
    expect(GITHUB_OIDC_REF).toBe("refs/heads/main");
    expect([...GITHUB_OIDC_EVENT_NAMES]).toEqual([
      "schedule",
      "workflow_dispatch",
    ]);
    expect(Object.keys(pins).sort()).toEqual(
      [
        "audience",
        "environment",
        "jobWorkflowRefs",
        "repository",
        "repositoryId",
      ].sort(),
    );
  });

  it("fails closed: every JWT is refused with OidcError until W5b", async () => {
    for (const jwt of ["", "a.b.c", "not a jwt"]) {
      const err = await verify(jwt, pins).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OidcError);
      expect((err as OidcError).code).toBe("not_implemented");
    }
  });

  it("types the claims the pins check", () => {
    const c: Claims = {
      iss: GITHUB_OIDC_ISSUER,
      aud: pins.audience,
      sub: "repo:open-artifacts-ai/open-artifacts:environment:redline-staging",
      iat: 0,
      nbf: 0,
      exp: 600,
      repository: pins.repository,
      repository_id: pins.repositoryId,
      ref: GITHUB_OIDC_REF,
      job_workflow_ref: pins.jobWorkflowRefs[0] ?? "",
      environment: pins.environment,
      event_name: "schedule",
      runner_environment: "github-hosted",
    };
    expect(Object.keys(c)).toHaveLength(13);
  });
});
