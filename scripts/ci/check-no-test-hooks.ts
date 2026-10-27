// Release guard for the /__test/* hooks (P2 T14). Runs a BUILT release Worker
// bundle (the --outdir of `wrangler deploy --dry-run`) in Miniflare with the
// hooks' runtime switches all on (TEST_HOOKS=1, a valid 48-char key, a
// TEST_DOMAIN, RL_ANON bound) and asserts every /__test/* path answers 404
// (none with a hook refusal reason in error.details) while /healthz answers
// 200 without testHooks. Prints one line; exits 0 or 1.
// Usage: node --experimental-strip-types scripts/ci/check-no-test-hooks.ts <bundle-dir>
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
// Keep in sync with @oa/shared TEST_HOOKS (plus an unknown hook path).
const HOOK_PATHS = [
  "/__test/session",
  "/__test/otp/latest",
  "/__test/oauth-client",
  "/__test/audit",
  "/__test/x",
];
const METHODS = ["GET", "POST"];
const NAME = "check-no-test-hooks";

const files = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)],
  );

type Result = [ok: boolean, msg: string];

/** error.details.reason in a JSON error body, if any. */
function refusalReason(text: string): unknown {
  try {
    return (JSON.parse(text) as { error?: { details?: { reason?: unknown } } })
      ?.error?.details?.reason;
  } catch {
    return undefined;
  }
}
const done = (ok: boolean, msg: string): Result => [ok, msg];

// The slice of the Miniflare API used here (it ships with apps/server's
// wrangler, not as a root dependency).
type Mf = {
  dispatchFetch(url: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
};
type MiniflareModule = {
  Miniflare: new (opts: unknown) => Mf;
  convertV4MiniflareOptions(opts: unknown): unknown;
};

async function loadMiniflare(): Promise<MiniflareModule> {
  const fromServer = createRequire(join(root, "apps/server/package.json"));
  const wrangler = fromServer.resolve("wrangler/package.json");
  const path = createRequire(wrangler).resolve("miniflare");
  return (await import(pathToFileURL(path).href)) as MiniflareModule;
}

async function main(): Promise<Result> {
  const arg = process.argv[2];
  if (!arg) return done(false, "usage: check-no-test-hooks.ts <bundle-dir>");
  const dir = resolve(arg);
  const entry = join(dir, "index.js");
  if (!existsSync(entry)) return done(false, `no bundle at ${entry}`);

  const { Miniflare, convertV4MiniflareOptions } = await loadMiniflare();
  const key = randomBytes(36).toString("base64url"); // 48 chars
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      // Worker console output stays out of the one-line result.
      handleStructuredLogs() {},
      workers: [
        {
          name: "release",
          modulesRoot: dir,
          // The entry first, then every other module the bundle emitted.
          modules: [
            entry,
            ...files(dir).filter(
              (f) => f !== entry && /\.(m?js|wasm)$/.test(f),
            ),
          ].map((path) => ({
            type: path.endsWith(".wasm") ? "CompiledWasm" : "ESModule",
            path,
          })),
          compatibilityDate: "2026-01-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          kvNamespaces: ["OAUTH_KV"],
          r2Buckets: ["FILES"],
          durableObjects: { ARTIFACT_RUNTIME: "ArtifactRuntime" },
          ratelimits: {
            RL_ANON: {
              namespace_id: "1001",
              simple: { limit: 1000, period: 60 },
            },
          },
          bindings: {
            APP_HOST: "app.localhost",
            CONTENT_HOST: "content.localhost",
            ENVIRONMENT: "production",
            OWNER_EMAIL: "owner@p5.test",
            ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
            ACCESS_CLIENT_ID: "test-client-id",
            ACCESS_CLIENT_SECRET: "test-client-secret",
            SESSION_SECRET: randomBytes(32).toString("hex"),
            CONTENT_SIGNING_KEY: randomBytes(32).toString("hex"),
            CF_ACCOUNT_ID: "test-account",
            TEST_HOOKS: "1",
            TEST_HOOK_KEY: key,
            TEST_DOMAIN: "p5.test",
          },
        },
      ],
    }),
  );
  try {
    const health = await mf.dispatchFetch("http://app.localhost/healthz");
    const h = (await health.json().catch(() => null)) as {
      testHooks?: unknown;
    } | null;
    if (health.status !== 200 || !h)
      return done(
        false,
        `GET /healthz -> ${health.status} (bundle not serving)`,
      );
    if (h.testHooks !== undefined)
      return done(false, "GET /healthz reports testHooks");
    let n = 0;
    for (const path of HOOK_PATHS)
      for (const method of METHODS) {
        const r = await mf.dispatchFetch(`http://app.localhost${path}`, {
          method,
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            "cf-connecting-ip": "198.51.100.7",
          },
          body:
            method === "GET"
              ? undefined
              : JSON.stringify({ email: "a@p5.test", role: "member" }),
        });
        const text = await r.text();
        if (r.status !== 404)
          return done(false, `${method} ${path} -> ${r.status} (want 404)`);
        // A hook refusal past the key carries error.details.reason; the
        // release build has no hook, so no 404 may carry one.
        if (refusalReason(text) !== undefined)
          return done(
            false,
            `${method} ${path} -> 404 with a hook refusal reason`,
          );
        n++;
      }
    return done(true, `${n} /__test/* requests all 404 with TEST_HOOKS=1`);
  } finally {
    await mf.dispose();
  }
}

const [ok, msg] = await main().catch(
  (e: unknown): Result => [
    false,
    `error: ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 300)}`,
  ],
);
console.log(`${NAME}: ${ok ? "ok" : "FAIL"}: ${msg}`);
process.exit(ok ? 0 : 1);
