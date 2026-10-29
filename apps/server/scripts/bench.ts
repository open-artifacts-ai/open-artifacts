/**
 * CPU-budget bench (task B17). Run: `pnpm --filter @oa/server bench`.
 *
 * Method: local workerd reports `cpuTime: 0` to tail consumers (verified on
 * wrangler 4.151 with a tail worker) and freezes performance.now() during
 * synchronous work, so per-request CPU is not observable there. Instead the
 * real Worker (src/index.ts default export, Hono app, MCP server, DO class)
 * runs in Node against in-process bindings (scripts/bench-env.ts), and each
 * request is metered with the calling thread's CPU clock:
 *
 *   worker CPU = thread CPU over fetch + waitUntil
 *                − CPU inside D1 (SQLite) and R2 shims (off-isolate in prod)
 *                − CPU inside DO methods (metered as the DO's own invocation)
 *
 * p95 over RUNS requests after WARMUP, with a forced GC before each request
 * when available (--expose-gc). Node's V8 ≠ workerd's V8 build, and native
 * pieces (IdentityTransformStream pipe, WebSocket send, RPC transport) are
 * approximated, so budgets are asserted at HEADROOM× the brief's numbers.
 */
import { LIMITS, newId } from "@oa/shared";
import { createPat } from "../src/auth/pat.js";
import { getDb } from "../src/db/client.js";
import { users } from "../src/db/schema.js";
import type { Env } from "../src/env.js";
import worker, { ArtifactRuntime } from "../src/index.js";
import { createServer } from "../src/mcp/server.js";
import {
  CLOCK,
  cpuMicros,
  D1Shim,
  DONamespaceShim,
  execCtx,
  FakeSocket,
  installGlobals,
  KVShim,
  meter,
  meterDo,
  R2Shim,
} from "./bench-env.js";

export const WARMUP = 10;
export const RUNS = 50;
/** Node-proxy allowance over the brief's workerd budgets. */
export const HEADROOM = 1.5;
/** The Workers Free per-request CPU limit: no headroom past it. */
export const HARD_LIMIT_MS = 10;

export type Bucket = "worker" | "do";
export type Sample = {
  worker: number;
  do: number;
  d1Queries: number;
  r2Ops: number;
  doCalls: number;
};
export type Scenario = {
  name: string;
  /** p95 budget in ms (the brief's / spec's number, before HEADROOM). */
  budgetMs: number;
  /** Which invocation the budget applies to. */
  bucket: Bucket;
  /** Unmetered per-iteration setup; returns the metered step. */
  prepare: () => Promise<() => Promise<unknown>>;
  /** Cold: no warmup and no forced gc (the first requests count). */
  cold?: boolean;
  /** Reported, never failed (no brief budget yet). */
  info?: boolean;
};
export type Result = {
  name: string;
  bucket: Bucket;
  budgetMs: number;
  limitMs: number;
  p50: number;
  p95: number;
  max: number;
  /** The other invocation's p95 (DO for worker scenarios, Worker for DO ones). */
  otherP95: number;
  subrequests: number;
  pass: boolean;
  info: boolean;
};

installGlobals();
const gc = (globalThis as { gc?: () => void }).gc;

const APP = "http://app.localhost";
const CONTENT = "http://content.localhost";
const MIGRATIONS = new URL("../migrations", import.meta.url).pathname;

/** The ASSETS binding: the runtime manifest, so content serving injects it. */
const assets = {
  fetch: async (req: Request) => {
    const p = new URL(req.url).pathname;
    if (p === "/_oa/runtime.manifest.json")
      return Response.json({ "src/index.ts": { file: "rt-bench.js" } });
    if (p === "/_oa/manifest.json")
      return Response.json({
        "src/index.ts": { file: "render-bench.js", css: ["r.css"] },
      });
    return new Response("not found", { status: 404 });
  },
};

export function makeEnv(): Env & {
  DB: D1Shim;
  FILES: R2Shim;
  ARTIFACT_RUNTIME: DONamespaceShim;
} {
  const env = {
    DB: new D1Shim(MIGRATIONS),
    FILES: new R2Shim(),
    OAUTH_KV: new KVShim(),
    ASSETS: assets,
    APP_HOST: "app.localhost",
    CONTENT_HOST: "content.localhost",
    ENVIRONMENT: "dev",
    OWNER_EMAIL: "owner@example.com",
    ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
    ACCESS_CLIENT_ID: "test-client-id",
    ACCESS_CLIENT_SECRET: "test-client-secret",
    SESSION_SECRET: "bench-session-secret-0123456789abcdef",
    CONTENT_SIGNING_KEY: "bench-content-signing-key-0123456789",
    CF_ACCOUNT_ID: "bench",
  } as Record<string, unknown>;
  env.ARTIFACT_RUNTIME = new DONamespaceShim(
    ArtifactRuntime as never,
    () => env,
  );
  return env as never;
}

export type BenchEnv = ReturnType<typeof makeEnv>;

/** Worker fetch with waitUntil settled; the body is always consumed. */
export async function call(env: BenchEnv, req: Request): Promise<Response> {
  const { ctx, settle } = execCtx();
  const res = await worker.fetch(req as never, env, ctx as never);
  const body = new Uint8Array(await res.arrayBuffer());
  await settle();
  return new Response(res.status === 204 || res.status === 101 ? null : body, {
    status: res.status,
    headers: res.headers,
  });
}

const enc = new TextEncoder();
export function apiReq(
  token: string,
  path: string,
  method = "GET",
  body?: Uint8Array | string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${APP}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: (typeof body === "string" ? enc.encode(body) : body) as BodyInit,
  });
}

export async function ok(r: Response, what: string): Promise<Response> {
  if (r.status >= 300)
    throw new Error(`${what}: ${r.status} ${await r.clone().text()}`);
  return r;
}

const WORDS =
  "budget alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike".split(
    " ",
  );
const prose = (bytes: number, seed = 0) => {
  let s = "";
  let i = seed;
  while (s.length < bytes) {
    s += `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} `;
    if (i % 12 === 11) s += "\n\n## Section\n\n";
    i++;
  }
  return s.slice(0, bytes);
};
export const htmlDoc = (bytes: number) => {
  const head =
    "<!doctype html><html><head><meta charset=utf-8><title>Bench</title></head><body>";
  let body = "";
  let i = 0;
  while (body.length < bytes - head.length - 20)
    body += `<div class="c${i % 9}"><p>${WORDS[i++ % WORDS.length]} text &amp; more</p></div>\n`;
  return `${head}${body}</body></html>`;
};
const b64 = (n: number) => {
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = (i * 2654435761) >>> 24;
  return Buffer.from(bytes).toString("base64");
};

export type Ctx = {
  env: BenchEnv;
  token: string;
  userId: string;
  ids: { html500: string; db: string; query: string; fanout: string };
};

async function publishVia(
  env: BenchEnv,
  token: string,
  input: Record<string, unknown>,
): Promise<string> {
  const r = await ok(
    await call(
      env,
      apiReq(token, "/api/v1/artifacts", "POST", JSON.stringify(input)),
    ),
    "publish",
  );
  return ((await r.json()) as { id: string }).id;
}

export async function setup(): Promise<Ctx> {
  const env = makeEnv();
  const userId = newId();
  await getDb(env).insert(users).values({
    id: userId,
    email: "owner@example.com",
    name: "owner",
    role: "owner",
    createdAt: Date.now(),
  });
  const { token } = await createPat(env, userId, "bench-agent");
  // 40 artifacts, so list 25 pages and search has more hits than a page.
  for (let i = 0; i < 40; i++)
    await publishVia(env, token, {
      title: `Bench note ${i} budget`,
      description: "A budget note",
      format: "markdown",
      content: prose(4096, i),
    });
  // Over the inline limit: create_upload, PUT, publish by uploadId.
  const page = htmlDoc(500 * 1024);
  const up = (await (
    await ok(
      await call(
        env,
        apiReq(
          token,
          "/api/v1/uploads",
          "POST",
          JSON.stringify({ path: "index.html", size: page.length }),
        ),
      ),
      "upload",
    )
  ).json()) as { uploadId: string; artifactId: string; url: string };
  const u = new URL(up.url);
  await ok(
    await call(
      env,
      new Request(`${APP}${u.pathname}${u.search}`, {
        method: "PUT",
        body: page,
        headers: { "content-length": String(page.length) },
      }),
    ),
    "upload PUT",
  );
  const html500 = await publishVia(env, token, {
    id: up.artifactId,
    title: "Big page",
    files: { "index.html": { uploadId: up.uploadId } },
  });
  const withDb = (title: string) =>
    publishVia(env, token, {
      title,
      format: "html",
      content: "<p>live</p>",
      capabilities: { db: true },
    });
  const ids = {
    html500,
    db: await withDb("db"),
    query: await withDb("query"),
    fanout: await withDb("fanout"),
  };
  return { env, token, userId, ids };
}

// ---------------------------------------------------------------- scenarios

export function scenarios(c: Ctx): Scenario[] {
  const { env, token, ids } = c;
  // The DO allows 100 writes/min per actor: move its clock a minute every 90 writes.
  let writes = 0;
  const tick = (id: string) => {
    const obj = env.ARTIFACT_RUNTIME.instance(id)
      .obj as unknown as ArtifactRuntime;
    const minute = Math.floor(writes++ / 90);
    obj.now = () => Date.now() + minute * 60_000;
  };
  const md50 = JSON.stringify({
    title: "Fifty KB",
    format: "markdown",
    content: prose(50 * 1024),
  });
  // Just under LIMITS.inlineBytes, the largest inline publish.
  const inline = LIMITS.inlineBytes - 2 * 1024;
  const bin19 = JSON.stringify({
    title: "Inline base64",
    files: {
      "index.html": "<!doctype html><img src=data.bin>",
      "data.bin": { base64: b64(inline) },
    },
  });
  const html19 = JSON.stringify({
    title: "Inline base64 html",
    files: {
      "index.html": {
        base64: Buffer.from(htmlDoc(inline)).toString("base64"),
      },
    },
  });
  // Indexing worst cases: the shapes that cost most per byte in extractText.
  const shaped = (unit: (i: number) => string) => {
    let h = "<!doctype html><html><head><title>t</title></head><body>";
    for (let i = 0; h.length < inline; i++) h += unit(i);
    return enc.encode(
      JSON.stringify({
        title: "Shaped",
        format: "html",
        content: h.slice(0, inline),
      }),
    );
  };
  const scriptDense = shaped(
    (i) => `<script>var a${i} = "<b>" + 1 < 2;</script><p>w${i}</p>\n`,
  );
  const entityDense = shaped(() => "&amp;&lt;&#x41;&#65;&nbsp;");
  const md50b = enc.encode(md50);
  const bin19b = enc.encode(bin19);
  const html19b = enc.encode(html19);
  const doc1k = enc.encode(
    JSON.stringify({ text: prose(1000), n: 1, done: false }),
  );
  const doc16k = enc.encode(
    JSON.stringify({ text: prose(16 * 1024 - 40).replace(/\n/g, " "), n: 2 }),
  );
  let contentPath = "";
  let docN = 0;
  const mcpBody = enc.encode(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  );
  const mcpReq = (body: Uint8Array = mcpBody) =>
    new Request(`${APP}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: body as BodyInit,
    });
  /** A tools/call request; the step fails on a tool error. */
  const mcpTool = (name: string, args: Record<string, unknown>) => {
    const req = mcpReq(
      enc.encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      ),
    );
    return async () => {
      const t = await (await ok(await call(env, req), name)).text();
      if (t.includes('"isError":true')) throw new Error(`${name}: ${t}`);
    };
  };

  return [
    // First, so nothing has run extractText on this shape yet.
    {
      name: "publish 126 KB inline html, script-dense, COLD (first requests, no gc)",
      budgetMs: 9,
      bucket: "worker",
      cold: true,
      prepare: async () => {
        const req = apiReq(token, "/api/v1/artifacts", "POST", scriptDense);
        return () => call(env, req).then((r) => ok(r, "publish cold"));
      },
    },
    {
      name: "publish 50 KB markdown",
      budgetMs: 8,
      bucket: "worker",
      prepare: async () => {
        const req = apiReq(token, "/api/v1/artifacts", "POST", md50b);
        return () => call(env, req).then((r) => ok(r, "publish md"));
      },
    },
    {
      name: "publish 126 KB inline base64 (binary file)",
      budgetMs: 9,
      bucket: "worker",
      prepare: async () => {
        const req = apiReq(token, "/api/v1/artifacts", "POST", bin19b);
        return () => call(env, req).then((r) => ok(r, "publish b64"));
      },
    },
    {
      name: "publish 126 KB inline base64 (html entry, indexing enqueued)",
      budgetMs: 9,
      bucket: "worker",
      prepare: async () => {
        const req = apiReq(token, "/api/v1/artifacts", "POST", html19b);
        return () => call(env, req).then((r) => ok(r, "publish b64 html"));
      },
    },
    ...(
      [
        ["script-dense", scriptDense],
        ["entity-dense", entityDense],
      ] as const
    ).map(
      ([shape, body]): Scenario => ({
        name: `publish 126 KB inline html, ${shape} (indexing enqueued)`,
        budgetMs: 9,
        bucket: "worker",
        prepare: async () => {
          const req = apiReq(token, "/api/v1/artifacts", "POST", body);
          return () => call(env, req).then((r) => ok(r, `publish ${shape}`));
        },
      }),
    ),
    // C3: the same 126 KB html bodies, indexed by the DO alarm (its own invocation).
    ...(
      [
        ["plain", html19b],
        ["script-dense", scriptDense],
        ["entity-dense", entityDense],
      ] as const
    ).map(
      ([shape, body]): Scenario => ({
        name: `DO alarm: index 126 KB html, ${shape}`,
        budgetMs: 10,
        bucket: "do",
        info: true,
        prepare: async () => {
          const r = await ok(
            await call(env, apiReq(token, "/api/v1/artifacts", "POST", body)),
            `publish ${shape}`,
          );
          const { id } = (await r.json()) as { id: string };
          const obj = env.ARTIFACT_RUNTIME.instance(id)
            .obj as unknown as ArtifactRuntime;
          return async () => {
            await meterDo(() => obj.alarm());
            if (obj.pendingIndex()) throw new Error("alarm did not index");
          };
        },
      }),
    ),
    {
      name: "content __view html with injection, 500 KB entry",
      budgetMs: 5,
      bucket: "worker",
      prepare: async () => {
        if (!contentPath) {
          const r = await ok(
            await call(
              env,
              apiReq(token, `/api/v1/artifacts/${ids.html500}/content-url`),
            ),
            "content-url",
          );
          const { url } = (await r.json()) as { url: string };
          const u = new URL(url);
          contentPath = u.pathname.replace(/[^/]*$/, "__view");
        }
        const req = new Request(`${CONTENT}${contentPath}`);
        return async () => {
          const r = await ok(await call(env, req), "__view");
          if (!(await r.text()).includes("rt-bench.js"))
            throw new Error("runtime not injected");
        };
      },
    },
    {
      name: "list 25",
      budgetMs: 5,
      bucket: "worker",
      prepare: async () => {
        const req = apiReq(token, "/api/v1/artifacts?limit=25");
        return () => call(env, req).then((r) => ok(r, "list"));
      },
    },
    {
      name: "search",
      budgetMs: 6,
      bucket: "worker",
      prepare: async () => {
        const req = apiReq(token, "/api/v1/search?q=budget%20note");
        return () => call(env, req).then((r) => ok(r, "search"));
      },
    },
    {
      name: "db.set (1 KB doc) - Worker",
      budgetMs: 4,
      bucket: "worker",
      prepare: async () => {
        tick(ids.db);
        const req = apiReq(
          token,
          `/api/v1/artifacts/${ids.db}/data/todos/d${docN++ % 50}`,
          "PUT",
          doc1k,
        );
        return () => call(env, req).then((r) => ok(r, "db.set"));
      },
    },
    {
      name: "db.set (1 KB doc) - DO",
      budgetMs: 4,
      bucket: "do",
      prepare: async () => {
        tick(ids.db);
        const req = apiReq(
          token,
          `/api/v1/artifacts/${ids.db}/data/todos/e${docN++ % 50}`,
          "PUT",
          doc1k,
        );
        return () => call(env, req).then((r) => ok(r, "db.set"));
      },
    },
    {
      name: "MCP tools/list",
      budgetMs: 6,
      bucket: "worker",
      prepare: async () => {
        const req = mcpReq();
        return async () => {
          const r = await ok(await call(env, req), "tools/list");
          if (!(await r.text()).includes("publish_artifact"))
            throw new Error("tools/list: no tools");
        };
      },
    },
    // ---- MCP tool calls (informational: no brief budget yet)
    {
      name: "MCP artifact_data_set (1 KB doc)",
      budgetMs: 6,
      bucket: "worker",
      info: true,
      prepare: async () => {
        tick(ids.db);
        return mcpTool("artifact_data_set", {
          id: ids.db,
          collection: "todos",
          docId: `m${docN++ % 50}`,
          data: JSON.parse(new TextDecoder().decode(doc1k)),
        });
      },
    },
    {
      name: "MCP publish_artifact (50 KB markdown)",
      budgetMs: 8,
      bucket: "worker",
      info: true,
      prepare: async () =>
        mcpTool(
          "publish_artifact",
          JSON.parse(md50) as Record<string, unknown>,
        ),
    },
    {
      // C3: the largest body MCP reads (under MAX_MCP_BODY), refused by planFiles.
      name: "MCP publish_artifact 1.2 MB inline (oversize → too_large)",
      budgetMs: 10,
      bucket: "worker",
      info: true,
      prepare: async () => {
        const req = mcpReq(
          enc.encode(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: "publish_artifact",
                arguments: {
                  title: "big",
                  format: "html",
                  // ~1.2 MB, no characters JSON escapes.
                  content: `<p>${"word ".repeat(240_000)}</p>`,
                },
              },
            }),
          ),
        );
        return async () => {
          const t = await (await ok(await call(env, req), "mcp big")).text();
          if (!t.includes("too_large: Inline content is limited"))
            throw new Error(`mcp oversize: ${t.slice(0, 200)}`);
        };
      },
    },
    // ---- ledger-deferred scenarios (budget: the 10 ms request limit)
    {
      name: "DO query, collection just under 2 MiB",
      budgetMs: 10,
      bucket: "do",
      prepare: async () => {
        const req = apiReq(
          token,
          `/api/v1/artifacts/${ids.query}/data/big/query`,
          "POST",
          JSON.stringify({ where: { tag: "t7" }, orderBy: "n", limit: 100 }),
        );
        return () => call(env, req).then((r) => ok(r, "query"));
      },
    },
    {
      name: "DO set, 200-socket fan-out at 16 KB",
      budgetMs: 10,
      bucket: "do",
      prepare: async () => {
        tick(ids.fanout);
        const req = apiReq(
          token,
          `/api/v1/artifacts/${ids.fanout}/data/feed/doc${docN++ % 50}`,
          "PUT",
          doc16k,
        );
        const sockets = env.ARTIFACT_RUNTIME.instance(ids.fanout).state.sockets;
        return async () => {
          const before = sockets.map((x) => x.sent);
          await ok(await call(env, req), "fan-out set");
          // All 200 got the frame with the 16 KB doc inlined (not data:null).
          if (
            sockets.length !== 200 ||
            sockets.some((x, k) => x.sent - (before[k] ?? 0) < 16_000)
          )
            throw new Error("fan-out: doc not inlined to every socket");
        };
      },
    },
    {
      name: "cron purge, one run (50 artifacts × 20 files)",
      budgetMs: 10,
      bucket: "worker",
      prepare: async () => {
        seedPurgeable(env, c.userId, 50, 20);
        return async () => {
          const { ctx, settle } = execCtx();
          await worker.scheduled(
            { cron: "0 3 * * *", scheduledTime: Date.now() } as never,
            env,
            ctx as never,
          );
          await settle();
        };
      },
    },
    {
      name: "/mcp server construction (createServer)",
      budgetMs: 2,
      bucket: "worker",
      prepare: async () => {
        const user = {
          id: c.userId,
          email: "owner@example.com",
          name: "owner",
          role: "owner",
        } as never;
        return async () =>
          createServer({
            env,
            user,
            sessionEpoch: 0,
            agent: null,
            connection: `c:${c.userId}`,
            session: null,
          });
      },
    },
    {
      name: "OAuthProvider wrap overhead (GET /api/v1/me)",
      budgetMs: 1,
      bucket: "worker",
      prepare: oauthOverhead(c),
    },
  ];
}

/** 50 artifacts soft-deleted past the window, each with `files` R2 objects and a DO. */
function seedPurgeable(
  env: BenchEnv,
  userId: string,
  n: number,
  files: number,
) {
  const old = Date.now() - (LIMITS.softDeleteDays + 1) * 86400_000;
  const db = env.DB.sqlite;
  const ins = db.prepare(
    `insert into artifacts (id, owner_id, title, format, visibility, current_version,
       capabilities, allow_anonymous_writes, created_at, updated_at, deleted_at)
     values (?, ?, 't', 'markdown', 'private', 1, '{}', 0, ?, ?, ?)`,
  );
  for (let i = 0; i < n; i++) {
    const id = newId();
    ins.run(id, userId, old, old, old);
    for (let f = 0; f < files; f++)
      env.FILES.objects.set(`files/${id}/${newId()}`, {
        bytes: new Uint8Array(16),
      });
  }
}

/**
 * The OAuthProvider wrap (B14-2) on the real path: the Worker's default
 * export (serveAppHost → per-isolate OAuthProvider → app, plus the outer
 * security headers) vs the Hono app called directly. Sample: p95 of
 * (wrapped − direct) for an authenticated app request.
 */
function oauthOverhead(c: Ctx) {
  type F = { fetch: (r: Request, e: unknown, x: unknown) => Promise<Response> };
  return async () => {
    const w = worker as unknown as F;
    const req = apiReq(c.token, "/api/v1/me");
    const { app } = await import("../src/app.js");
    /** Worker CPU of one call (D1 excluded). */
    const run = async (f: typeof w) => {
      const t = cpuMicros();
      const e = meter.external;
      const { ctx } = execCtx();
      const r = await f.fetch(req.clone() as never, c.env, ctx);
      if (r.status !== 200) throw new Error(`oauth bench: ${r.status}`);
      await r.arrayBuffer();
      return cpuMicros() - t - (meter.external - e);
    };
    const direct = app as unknown as typeof w;
    return async () => {
      // Warm direct (discarded), wrapped (kept), direct again (subtracted):
      // the sample is wrapped − direct, both on a warm path.
      meter.external += await run(direct);
      await run(w);
      meter.external += 2 * (await run(direct));
    };
  };
}

// ------------------------------------------------------------- seed DO data

export function seedDo(c: Ctx) {
  const ns = c.env.ARTIFACT_RUNTIME;
  // Query: docs totalling just under MAX_QUERY_COLLECTION_BYTES (2 MiB).
  const q = ns.instance(c.ids.query).obj as unknown as ArtifactRuntime;
  const docBytes = 1000;
  const target = 2 * 1024 * 1024 - 64 * 1024;
  let total = 0;
  let i = 0;
  q.now = () => Date.now() - (i % 1000) * 60_000; // spread writes over minutes (rate limit)
  while (total < target) {
    const data = { tag: `t${i % 10}`, n: i, text: prose(docBytes - 60, i) };
    q.set("big", `doc${i}`, data, `agent:seed${i % 1000}`);
    total += JSON.stringify(data).length + 3 + `doc${i}`.length + 64 + 20;
    i++;
  }
  q.now = () => Date.now();
  const bytes = (
    ns
      .instance(c.ids.query)
      .state.db.prepare(
        `select json_extract(cols, '$."big"') as v from totals where id = 1`,
      )
      .get() as { v: number }
  ).v;
  // Fan-out: 200 hibernated sockets on the collection.
  const f = ns.instance(c.ids.fanout).state;
  for (let s = 0; s < 200; s++) f.acceptWebSocket(new FakeSocket([]), ["feed"]);
  if (bytes > 2 * 1024 * 1024 || bytes < 2 * 1024 * 1024 - 128 * 1024)
    throw new Error(`query collection is ${bytes} bytes, not just under 2 MiB`);
  return { queryDocs: i, queryBytes: bytes, sockets: f.sockets };
}

// ------------------------------------------------------------------ runner

const p = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] ?? 0;
};

export async function sample(
  s: Scenario,
  runs = RUNS,
  warmup = s.cold ? 0 : WARMUP,
): Promise<Sample[]> {
  const out: Sample[] = [];
  for (let i = 0; i < warmup + runs; i++) {
    const step = await s.prepare();
    if (!s.cold) gc?.();
    meter.reset();
    const t = cpuMicros();
    await step();
    const total = cpuMicros() - t;
    if (i < warmup) continue;
    out.push({
      worker: (total - meter.external - meter.durableObject) / 1000,
      do: meter.durableObject / 1000,
      d1Queries: meter.d1Queries,
      r2Ops: meter.r2Ops,
      doCalls: meter.doCalls,
    });
  }
  return out;
}

export function summarize(s: Scenario, xs: Sample[]): Result {
  const mine = xs.map((x) => (s.bucket === "worker" ? x.worker : x.do));
  const other = xs.map((x) => (s.bucket === "worker" ? x.do : x.worker));
  const p95 = p(mine, 0.95);
  const limitMs = Math.min(s.budgetMs * HEADROOM, HARD_LIMIT_MS);
  const last = xs[xs.length - 1];
  return {
    name: s.name,
    bucket: s.bucket,
    budgetMs: s.budgetMs,
    limitMs,
    p50: p(mine, 0.5),
    p95,
    max: Math.max(...mine),
    otherP95: p(other, 0.95),
    subrequests: last ? last.d1Queries + last.r2Ops + last.doCalls : 0,
    pass: s.info === true || p95 <= limitMs,
    info: s.info === true,
  };
}

export function table(rs: Result[]): string {
  const f = (n: number) => n.toFixed(2);
  const rows = rs.map(
    (r) =>
      `| ${r.name} | ${r.bucket} | ${f(r.p50)} | ${f(r.p95)} | ${f(r.max)} | ${f(r.otherP95)} | ${r.subrequests} | ${r.budgetMs} (${f(r.limitMs)}) | ${r.info ? "info" : r.pass ? "pass" : "FAIL"} |`,
  );
  return [
    `CPU clock: ${CLOCK}; ${RUNS} runs after ${WARMUP} warmup (cold rows: none); gc: ${gc ? "forced, except cold rows" : "off"}`,
    "| scenario | bucket | p50 ms | p95 ms | max ms | other-bucket p95 ms | subrequests | budget ms (limit: min(×1.5, 10)) | result |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

export async function runAll(filter?: RegExp): Promise<Result[]> {
  const c = await setup();
  seedDo(c);
  const out: Result[] = [];
  for (const s of scenarios(c)) {
    if (filter && !filter.test(s.name)) continue;
    out.push(summarize(s, await sample(s)));
  }
  return out;
}
