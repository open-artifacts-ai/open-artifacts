import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  GITHUB_OIDC_ISSUER,
  GITHUB_OIDC_REF,
  JwksCache,
  type VerifyOptions,
} from "@oa/gh-oidc";
import {
  ADMIN_TOOL_NAMES,
  ADMIN_TOOLS,
  type AdminToolName,
  ROUTES,
} from "@oa/shared/provisioning";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { STAGING_API_HOST } from "../src/auth/oidc.js";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { ctx, fakeEnv, requestId, resetDb, seedInstall } from "./fakes.js";

// Staging /mcp with the red-line GitHub OIDC JWT (design v7 9A.10, 4.4):
// exactly the O column, the same answers as /v1. A real RS256 key and JWKS
// behind a fake fetch, so gh-oidc's verify runs end to end.

const keys = vi.hoisted(() => ({ jwk: null as JsonWebKey | null }));
vi.mock("../src/auth/oidc.js", async (orig) => {
  const m = await orig<typeof import("../src/auth/oidc.js")>();
  const opts = (): VerifyOptions => ({
    fetch: (async () =>
      new Response(JSON.stringify({ keys: [keys.jwk] }))) as typeof fetch,
    now: () => Date.now(),
    jwks: new JwksCache(),
    cache: null,
  });
  return {
    ...m,
    oidcPrincipal: (req: Request, env: Env, jwt: string) =>
      m.oidcPrincipal(req, env, jwt, opts()),
  };
});

const REPO = "open-artifacts-ai/open-artifacts";
const WF = `${REPO}/.github/workflows/redline-staging.yml@refs/heads/main`;
const BASE = `https://${STAGING_API_HOST}`;

const b64u = (b: ArrayBuffer | string) => {
  const bytes =
    typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};
let priv: CryptoKey;
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
  keys.jwk = {
    kty: "RSA",
    n: pub.n,
    e: pub.e,
    kid: "k1",
    alg: "RS256",
  } as JsonWebKey;
});
async function jwt() {
  const s = Math.floor(Date.now() / 1000);
  const claims = {
    iss: GITHUB_OIDC_ISSUER,
    aud: BASE,
    sub: `repo:${REPO}:environment:redline-staging`,
    iat: s - 5,
    nbf: s - 5,
    exp: s + 295,
    repository: REPO,
    repository_id: "4242",
    ref: GITHUB_OIDC_REF,
    job_workflow_ref: WF,
    environment: "redline-staging",
    event_name: "workflow_dispatch",
    runner_environment: "github-hosted",
  };
  const input = `${b64u(JSON.stringify({ alg: "RS256", kid: "k1" }))}.${b64u(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    priv,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64u(sig)}`;
}
const envOf = (over: Partial<Env> = {}) =>
  fakeEnv({
    OA_ENV: "staging",
    APP_DOMAIN: "open-artifacts-staging.app",
    OIDC_AUDIENCE: BASE,
    OIDC_REPOSITORY: REPO,
    OIDC_REPOSITORY_ID: "4242",
    OIDC_JOB_WORKFLOW_REFS: WF,
    OIDC_ENVIRONMENT: "redline-staging",
    ...over,
  }).env;

beforeEach(() => resetDb());

/** Cloudflare sets cf-connecting-ip on every edge request; tests do too. */
const withIp = (r: Request) => {
  if (r.headers.has("cf-connecting-ip")) return r;
  const out = new Request(r);
  out.headers.set("cf-connecting-ip", "192.0.2.9");
  return out;
};
const fetchWorker = (r: Request, env: Env) =>
  worker.fetch(withIp(r) as Parameters<typeof worker.fetch>[0], env, ctx());

async function connect(env: Env, bearer: string, headers = {}) {
  const client = new Client({ name: "redline", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${bearer}`, ...headers },
      },
      fetch: (url, init) =>
        fetchWorker(new Request(String(url), init as RequestInit), env),
    }),
  );
  return client;
}

function restReq(
  bearer: string,
  name: AdminToolName,
  args: Record<string, unknown>,
) {
  const t = ADMIN_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(name);
  const def = ROUTES[t.route];
  let path = def.path;
  const q = new URLSearchParams();
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries({ ...t.defaults, ...args })) {
    if (k in def.params.shape) path = path.replace(`:${k}`, String(v));
    else if (k in def.query.shape) q.set(k, String(v));
    else body[k] = v;
  }
  return new Request(`${BASE}/v1${path}${q.size ? `?${q}` : ""}`, {
    method: def.method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(def.method === "GET" ? {} : { "content-type": "application/json" }),
    },
    ...(def.method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
}

describe("OIDC on staging /mcp (9A.10)", () => {
  it("tools/list names ADMIN_TOOLS; every answer equals /v1 (the O column)", async () => {
    const env = envOf();
    const bearer = await jwt();
    const client = await connect(env, bearer);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      ...ADMIN_TOOL_NAMES,
    ]);
    const rl = await seedInstall({ slug: "rl-p1", testHooks: true });
    const other = await seedInstall({ slug: "acme" });
    const cases: [AdminToolName, Record<string, unknown>, number][] = [
      ["whoami", {}, 200],
      ["get_world", {}, 403],
      ["list_installs", {}, 200],
      ["get_install", { id: rl.id }, 200],
      ["get_install", { id: other.id }, 404],
      [
        "delete_install",
        { id: rl.id, requestId: requestId(), confirmSlug: "rl-x" },
        400,
      ],
      ["upgrade_install", { id: rl.id, requestId: requestId() }, 202],
    ];
    for (const [name, args, status] of cases) {
      const h = await fetchWorker(restReq(bearer, name, args), env);
      expect(h.status, name).toBe(status);
      const hb = (await h.json()) as { error?: { code: string } };
      const m = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        // biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary JSON
        structuredContent: any;
      };
      if (status < 300) expect(m.structuredContent, name).toEqual(hb);
      else {
        expect(m.isError, name).toBe(true);
        expect(m.structuredContent.error.code, name).toBe(hb.error?.code);
      }
    }
    const list = (await client.callTool({
      name: "list_installs",
      arguments: {},
    })) as { structuredContent: { items: { slug: string }[] } };
    expect(list.structuredContent.items.map((i) => i.slug)).toEqual(["rl-p1"]);
  });

  it("an upgrade's job names the OIDC actor", async () => {
    const env = envOf();
    const client = await connect(env, await jwt());
    const rl = await seedInstall({ slug: "rl-p2", testHooks: true });
    const r = (await client.callTool({
      name: "upgrade_install",
      arguments: { id: rl.id, requestId: requestId() },
    })) as { structuredContent: { job: { actor: unknown } } };
    expect(r.structuredContent.job.actor).toEqual({
      kind: "oidc",
      label: REPO,
      tokenId: null,
    });
  });

  it("prod refuses OIDC on /mcp: 401", async () => {
    const env = envOf({ OA_ENV: "prod" });
    const res = await fetchWorker(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await jwt()}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("an x-oa-test-user caller is a self-serve user: 401 on /mcp", async () => {
    const env = envOf();
    const res = await fetchWorker(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await jwt()}`,
          "x-oa-test-user": "a",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });
});
