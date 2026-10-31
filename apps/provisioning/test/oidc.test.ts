import {
  GITHUB_OIDC_ISSUER,
  GITHUB_OIDC_REF,
  JwksCache,
  type VerifyOptions,
} from "@oa/gh-oidc";
import { beforeAll, describe, expect, it } from "vitest";
import { oidcPins, oidcPrincipal, STAGING_API_HOST } from "../src/auth/oidc.js";
import type { Env } from "../src/env.js";
import { fakeEnv } from "./fakes.js";

// A real RS256 key and JWKS behind a fake fetch, so gh-oidc's verify runs
// end to end; the clock is pinned.
const T = 1_800_000_000_000;
const S = T / 1000;
const REPO = "open-artifacts-ai/open-artifacts";
const WF = `${REPO}/.github/workflows/redline-staging.yml@refs/heads/main`;
const AUD = `https://${STAGING_API_HOST}`;

const b64u = (b: ArrayBuffer | string) => {
  const bytes =
    typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};
let priv: CryptoKey;
let jwk: JsonWebKey;
beforeAll(async () => {
  const k = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  priv = k.privateKey;
  const pub = (await crypto.subtle.exportKey("jwk", k.publicKey)) as JsonWebKey;
  jwk = {
    kty: "RSA",
    n: pub.n,
    e: pub.e,
    kid: "k1",
    alg: "RS256",
  } as JsonWebKey;
});
async function jwt(over: Record<string, unknown> = {}) {
  const claims = {
    iss: GITHUB_OIDC_ISSUER,
    aud: AUD,
    sub: `repo:${REPO}:environment:redline-staging`,
    iat: S - 5,
    nbf: S - 5,
    exp: S + 295,
    repository: REPO,
    repository_id: "4242",
    ref: GITHUB_OIDC_REF,
    job_workflow_ref: WF,
    environment: "redline-staging",
    event_name: "workflow_dispatch",
    runner_environment: "github-hosted",
    ...over,
  };
  const input = `${b64u(JSON.stringify({ alg: "RS256", kid: "k1" }))}.${b64u(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    priv,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64u(sig)}`;
}
const vopts = (): VerifyOptions => ({
  fetch: (async () =>
    new Response(JSON.stringify({ keys: [jwk] }))) as typeof fetch,
  now: () => T,
  jwks: new JwksCache(),
  cache: null,
});
const stagingEnv = (over: Partial<Env> = {}) =>
  fakeEnv({
    OA_ENV: "staging",
    APP_DOMAIN: "open-artifacts-staging.app",
    OIDC_AUDIENCE: AUD,
    OIDC_REPOSITORY: REPO,
    OIDC_REPOSITORY_ID: "4242",
    OIDC_JOB_WORKFLOW_REFS: `${WF}, ${REPO}/.github/workflows/other.yml@refs/heads/main`,
    OIDC_ENVIRONMENT: "redline-staging",
    ...over,
  }).env;
const req = (headers: Record<string, string> = {}, host = STAGING_API_HOST) =>
  new Request(`https://${host}/v1/me`, { headers });
const unauth = { refusal: true, code: "unauthenticated" };

describe("GitHub OIDC principal (4.4)", () => {
  it("is the staging api host only", () => {
    expect(STAGING_API_HOST).toBe("api.open-artifacts-staging.app");
  });

  it("pins come from every OIDC_* var; the workflow refs are a comma list", () => {
    expect(oidcPins(stagingEnv())).toEqual({
      audience: AUD,
      repository: REPO,
      repositoryId: "4242",
      jobWorkflowRefs: [
        WF,
        `${REPO}/.github/workflows/other.yml@refs/heads/main`,
      ],
      environment: "redline-staging",
    });
  });

  it("any OIDC_* var unset or empty: no pins", () => {
    for (const k of [
      "OIDC_AUDIENCE",
      "OIDC_REPOSITORY",
      "OIDC_REPOSITORY_ID",
      "OIDC_JOB_WORKFLOW_REFS",
      "OIDC_ENVIRONMENT",
    ] as const) {
      expect(oidcPins(stagingEnv({ [k]: undefined })), k).toBeNull();
      expect(oidcPins(stagingEnv({ [k]: "" })), k).toBeNull();
    }
    expect(oidcPins(stagingEnv({ OIDC_JOB_WORKFLOW_REFS: " , " }))).toBeNull();
  });

  it("environment is pinned to redline-staging; any other OIDC_ENVIRONMENT has no pins", () => {
    for (const v of ["production", "redline-staging ", "*"])
      expect(oidcPins(stagingEnv({ OIDC_ENVIRONMENT: v })), v).toBeNull();
    expect(oidcPins(stagingEnv())?.environment).toBe("redline-staging");
  });

  it("prod has no pins, whatever its vars say", () => {
    expect(oidcPins(stagingEnv({ OA_ENV: "prod" }))).toBeNull();
  });

  it("a good token is the oidc principal keyed by repository_id", async () => {
    const p = await oidcPrincipal(req(), stagingEnv(), await jwt(), vopts());
    expect(p).toEqual({
      kind: "oidc",
      actorKey: "oidc:4242",
      rateKey: "oidc:4242",
      label: REPO,
      scopes: [],
      sub: `repo:${REPO}:environment:redline-staging`,
      authAt: null,
    });
  });

  it("prod refuses even a good token", async () => {
    expect(
      await oidcPrincipal(
        req(),
        stagingEnv({ OA_ENV: "prod" }),
        await jwt(),
        vopts(),
      ),
    ).toEqual(unauth);
  });

  it("another host refuses (the prod api host, a staging tenant)", async () => {
    for (const host of ["api.open-artifacts.app", "api.hosted.test"])
      expect(
        await oidcPrincipal(req({}, host), stagingEnv(), await jwt(), vopts()),
      ).toEqual(unauth);
  });

  it("missing pins refuse", async () => {
    expect(
      await oidcPrincipal(
        req(),
        stagingEnv({ OIDC_REPOSITORY_ID: undefined }),
        await jwt(),
        vopts(),
      ),
    ).toEqual(unauth);
  });

  it("any verify failure is 401, never the reason", async () => {
    for (const over of [
      { repository_id: "1" },
      { aud: "https://api.open-artifacts.app" },
      { exp: S - 61, iat: S - 300, nbf: S - 300 },
      { event_name: "push" },
    ])
      expect(
        await oidcPrincipal(req(), stagingEnv(), await jwt(over), vopts()),
      ).toEqual(unauth);
  });

  it("x-oa-test-user a|b|c: the self-serve test user (M4)", async () => {
    for (const l of ["a", "b", "c"]) {
      const p = await oidcPrincipal(
        req({ "x-oa-test-user": l }),
        stagingEnv(),
        await jwt(),
        vopts(),
      );
      expect(p).toEqual({
        kind: "user",
        actorKey: `user:rl-test-${l}`,
        rateKey: `user:rl-test-${l}`,
        label: `rl-test-${l}@test.invalid`,
        scopes: [],
        email: `rl-test-${l}@test.invalid`,
        sub: `rl-test-${l}`,
        hd: "test.invalid",
        authAt: null,
      });
    }
  });

  it("any other x-oa-test-user value refuses", async () => {
    for (const v of ["d", "A", "", "a,b", "admin"])
      expect(
        await oidcPrincipal(
          req({ "x-oa-test-user": v }),
          stagingEnv(),
          await jwt(),
          vopts(),
        ),
        v,
      ).toEqual(unauth);
  });
});
