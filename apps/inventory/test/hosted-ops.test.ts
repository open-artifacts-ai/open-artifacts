// hosted-ops' prod create/upgrade precheck (#986) against prod's committed
// pins, through @oa/gh-oidc's real verify with a test key: on main in
// redline-staging it reads the three GET routes; POST /prodclean stays the
// monitor's; another ref, environment or event is the fixed 401.
import { readFileSync } from "node:fs";
import { GITHUB_OIDC_ISSUER, verify as ghVerify, JwksCache } from "@oa/gh-oidc";
import { beforeAll, describe, expect, it } from "vitest";
import type { OidcVars } from "../src/auth.ts";
import { makeWorker } from "../src/index.ts";
import { HOSTED_OPS, makeDb, makeEnv, NOW, REPO, req, WF } from "./support.ts";

const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as {
  env: { prod: { vars: OidcVars } };
};
const PROD = {
  ...cfg.env.prod.vars,
  OIDC_REPOSITORY_ID: "123456",
} as Required<OidcVars>;

const b64u = (b: ArrayBuffer | string) => {
  const bytes =
    typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b);
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

let priv: CryptoKey;
let jwk: JsonWebKey & { kid: string };
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
  const pub = await crypto.subtle.exportKey("jwk", k.publicKey);
  jwk = { kty: pub.kty, n: pub.n, e: pub.e, kid: "k1", alg: "RS256" };
});

const S = NOW / 1000;
const good = (): Record<string, unknown> => ({
  iss: GITHUB_OIDC_ISSUER,
  aud: PROD.OIDC_AUDIENCE,
  sub: `repo:${REPO}:environment:redline-staging`,
  iat: S - 10,
  nbf: S - 10,
  exp: S + 290,
  repository: REPO,
  repository_id: PROD.OIDC_REPOSITORY_ID,
  ref: "refs/heads/main",
  job_workflow_ref: HOSTED_OPS,
  environment: "redline-staging",
  event_name: "workflow_dispatch",
  runner_environment: "github-hosted",
});

async function sign(claims: Record<string, unknown>) {
  const input = `${b64u(JSON.stringify({ alg: "RS256", kid: "k1" }))}.${b64u(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    priv,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64u(sig)}`;
}

const w = makeWorker({
  verify: (jwt, pins) =>
    ghVerify(jwt, pins, {
      fetch: (async () =>
        new Response(JSON.stringify({ keys: [jwk] }), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
      now: () => NOW,
      jwks: new JwksCache(),
      cache: null,
    }),
  now: () => NOW,
});

async function call(
  path: string,
  claims: Record<string, unknown>,
  method = "GET",
) {
  const d = makeDb();
  const init: RequestInit =
    method === "POST"
      ? {
          method,
          body: JSON.stringify({ ok: true, code: "pass" }),
          headers: { "content-type": "application/json" },
        }
      : {};
  const res = await w.fetch(
    req(path, init, `Bearer ${await sign(claims)}`),
    makeEnv({ ...PROD, PLATFORM_DB: d.db }),
  );
  return { res, runs: d.runs };
}

const GETS = ["/installs", "/hosts", "/health"];

describe("hosted-ops' prod precheck (#986)", () => {
  it("prod lists hosted-ops on main, in redline-staging", () => {
    expect(PROD.OIDC_JOB_WORKFLOW_REFS.split(",")).toContain(HOSTED_OPS);
    expect(PROD.OIDC_ENVIRONMENT).toBe("redline-staging");
  });

  it("on main in redline-staging: the three GET routes answer 200", async () => {
    for (const p of GETS) {
      const { res } = await call(p, good());
      expect(res.status, p).toBe(200);
    }
  });

  it("POST /prodclean stays the monitor's: 403, nothing written", async () => {
    const { res, runs } = await call("/prodclean", good(), "POST");
    expect(res.status).toBe(403);
    expect(runs).toEqual([]);
  });

  const refused: [string, Record<string, unknown>][] = [
    ["another branch", { ref: "refs/heads/dev" }],
    [
      "hosted-ops from another branch",
      {
        ref: "refs/heads/dev",
        job_workflow_ref: `${WF}/hosted-ops.yml@refs/heads/dev`,
      },
    ],
    [
      "a tag",
      {
        ref: "refs/tags/v1.0.0",
        job_workflow_ref: `${WF}/hosted-ops.yml@refs/tags/v1.0.0`,
      },
    ],
    [
      "hosted-prod-deploy",
      {
        environment: "hosted-prod-deploy",
        sub: `repo:${REPO}:environment:hosted-prod-deploy`,
      },
    ],
    [
      "hosted-staging-deploy",
      {
        environment: "hosted-staging-deploy",
        sub: `repo:${REPO}:environment:hosted-staging-deploy`,
      },
    ],
    ["a push", { event_name: "push" }],
    ["a pull request", { event_name: "pull_request" }],
  ];
  for (const [what, over] of refused)
    it(`${what} -> fixed 401 on every route`, async () => {
      for (const p of GETS) {
        const { res } = await call(p, { ...good(), ...over });
        expect(res.status, p).toBe(401);
        expect(await res.text()).toBe('{"error":"unauthorized"}');
      }
      const { res, runs } = await call(
        "/prodclean",
        { ...good(), ...over },
        "POST",
      );
      expect(res.status).toBe(401);
      expect(runs).toEqual([]);
    });
});
