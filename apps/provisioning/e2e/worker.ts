import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

// The provisioning Worker in Miniflare for browser e2e (W13b): bundled from
// src/index.ts, the real platform-db migrations, a local OAUTH_KV, rate
// limits bound, served over https. APP_DOMAIN is `localhost`; the browser
// maps admin.localhost:443 to the server (hostResolverRules), so pages see
// https://admin.localhost exactly as the issuer's metadata names it. The
// cross-site origin is http://127.0.0.1:<port>, another site.

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
export const EMAIL = "e2e@example.com";
export const SUB = "e2e-sub";
export const REDIRECT = "http://127.0.0.1:33418/callback";

const RL = [
  "RL_PV_PRE_IP",
  "RL_PV_SIGNIN_IP",
  "RL_PV_WRITE",
  "RL_PV_READ",
  "RL_PV_SLUG_IP",
  "RL_PV_OAUTH_IP",
];

export type Harness = {
  mf: Miniflare;
  port: number;
  /** Chromium's --host-resolver-rules for admin.localhost. */
  hostResolverRules: string;
  admin: string;
  sid: string;
  clientId: string;
  authorizePath: string;
  close: () => Promise<void>;
};

const b64url = (b: Buffer) => b.toString("base64url");

export async function startWorker(
  opts: { env?: "staging" | "prod" } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "oa-prov-e2e-"));
  const out = join(dir, "worker.js");
  await build({
    entryPoints: [join(app, "src/index.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    external: ["cloudflare:*", "node:*"],
    outfile: out,
    logLevel: "silent",
  });
  const text = (value: string) => ({ type: "text" as const, value });
  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    // A self-signed cert: the browser maps admin.localhost:443 here, so the
    // URLs are the production shape (https, no port).
    https: true,
    resourcePersistencePath: join(dir, "state"),
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "oa-provisioning-e2e",
          compatibilityDate: "2026-10-01",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: await readFile(out, "utf8"),
              },
            },
          },
          env: {
            PLATFORM_DB: { type: "d1", id: "e2e" },
            OAUTH_KV: { type: "kv", id: "e2e" },
            ...Object.fromEntries(
              RL.map((n, i) => [
                n,
                {
                  type: "rate-limit" as const,
                  namespace: String(9001 + i),
                  simple: { limit: 10_000, period: 60 as const },
                },
              ]),
            ),
            OA_ENV: text(opts.env ?? "staging"),
            APP_DOMAIN: text("localhost"),
            ADMIN_IDENTITIES: text(`${EMAIL}:${SUB}`),
            SIGNUPS_ENABLED: text("false"),
            SELF_SERVE_TIER: text("trial"),
            MCP_REDIRECT_URIS: text("https://claude.ai/api/mcp/auth_callback"),
            ADMIN_SESSION_KEY: text(b64url(randomBytes(32))),
            ADMIN_BROKER_KEY: text("unused"),
          },
        },
      },
    ],
  });
  const url = await mf.ready;
  const port = Number(url.port);
  const db = await mf.getD1Database("PLATFORM_DB");
  for (const m of await readD1Migrations(
    join(app, "../platform-db/migrations"),
  ))
    await db.batch(m.queries.map((q) => db.prepare(q)));

  // An admin session with 4 h left (consent needs 60 min).
  const sid = b64url(randomBytes(32));
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO sessions (id_hash, kind, host, email, sub, auth_at, created_at, expires_at)
       VALUES (?1, 'admin', 'admin.localhost', ?2, ?3, ?4, ?4, ?5)`,
    )
    .bind(
      createHash("sha256").update(sid).digest("hex"),
      EMAIL,
      SUB,
      now,
      now + 4 * 3_600_000,
    )
    .run();

  const reg = await mf.dispatchFetch("https://api.localhost/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "E2E agent",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
    }),
  });
  if (reg.status !== 201)
    throw new Error(`register: ${reg.status} ${await reg.text()}`);
  const { client_id: clientId } = (await reg.json()) as { client_id: string };

  const challenge = b64url(
    createHash("sha256")
      .update(b64url(randomBytes(32)))
      .digest(),
  );
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "installs:read audit:read",
    state: "st-e2e",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: "https://api.localhost/mcp",
  });
  return {
    mf,
    port,
    hostResolverRules: `MAP admin.localhost:443 127.0.0.1:${port}`,
    admin: "https://admin.localhost",
    sid,
    clientId,
    authorizePath: `/oauth/authorize?${q}`,
    close: async () => {
      await mf.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * The cross-site origin: `/link` is a page with a link to `target` (a click
 * from claude.ai); `/signin` a page whose link goes to `/return`, a 303 to
 * `target` (the end of the sign-in chain: a navigation started on Google's
 * site that redirects to the admin host).
 */
export async function crossSite(
  target: string,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === "/link" || req.url === "/signin") {
      const href = req.url === "/link" ? target : "/return";
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><a id="go" href="${href}">Continue</a>`);
    } else if (req.url === "/return") {
      res.writeHead(303, { location: target });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
