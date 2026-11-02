import { AUTH, planOf } from "@oa/shared";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { withBrokerProps } from "./auth/broker-transport.js";
import { withCredScope } from "./auth/cred.js";
import {
  enforcePolicy,
  mw,
  type Policy,
  planGate,
  ROUTE_POLICY,
} from "./auth/route-policy.js";
import { readSession, sessionCookieName } from "./auth/session.js";
import { authProviders } from "./auth/sign-in.js";
import { withPlanScope } from "./billing/features.js";
import { ApiError, errorJson, toErrorResponse } from "./http/errors.js";
import {
  type AppEnv,
  csrf,
  readOnlyCap,
  sameOrigin,
  securityHeaders,
  session,
} from "./http/middleware.js";
import { cancelUnreadOnRefusal } from "./http/unread-body.js";
import { LLMS_PATH, serveLlms } from "./mcp/llms.js";
import { mountOAuthCopy } from "./mcp/oauth-copy.js";
import { oauthStoreHealth } from "./mcp/oauth-store.js";
import { SKILL_PATH, serveSkill } from "./mcp/skill.js";
import { serveUpgrade, UPGRADE_PATH } from "./mcp/upgrade.js";
import { type AppType, mountRoutes } from "./routes/index.js";
import { publicHome, withInstanceMeta } from "./routes/shell.js";
import { mountTestHooks, testHooksOn } from "./test-hooks/index.js";
import { VERSION } from "./version.gen.js";

// Folds to `false` at bundle time in release builds (build-flags.d.ts), which
// leaves no reference to test-hooks/, so esbuild drops the module. (A
// non-minified bundle keeps `if (false)` bodies, so gate the reference.)
const hooks = typeof __OA_TEST_HOOKS_ALLOWED__ !== "undefined" &&
  __OA_TEST_HOOKS_ALLOWED__ === true && { mountTestHooks, testHooksOn };

/** The content host: nothing there is for crawlers. */
export const ROBOTS = "User-agent: *\nDisallow: /";

// The app host also opens the guides any AI agent is sent to read.
// Allow comes first for parsers that take the first match.
const APP_ROBOTS = `User-agent: *\nAllow: ${LLMS_PATH}\nAllow: ${SKILL_PATH}\nAllow: ${UPGRADE_PATH}\nDisallow: /`;

export const methodNotAllowed = () =>
  errorJson(405, "bad_request", "Method not allowed", undefined, {
    Allow: "GET, HEAD",
  });

// Paths owned by the Worker; never served by the SPA fallback.
// (/a/*, /no-access and /search are SPA routes and fall through to ASSETS.)
// /_oa/* (render bundles) is content-host only: a JSON 404 here. /__oa/* is
// reserved for platform internals: a JSON 404, never the SPA, except POST
// /__oa/oauth-store/copy where it is on (mcp/oauth-copy.ts).
const WORKER_PREFIX =
  /^\/(api|auth|oauth|\.well-known|mcp|_oa|__oa|__test)(\/|$)/;

// Text and Markdown files the Worker doesn't serve (/robots.txt, /skill.md,
// /upgrade.md and /llms.txt are routes, matched before the fallback): a plain
// 404, never the SPA shell, so an agent that guesses a wrong file sees "not
// found". The built bundle under /assets/ still goes to ASSETS; a missing one
// is the same plain 404.
const TEXT_FILE = /\.(txt|md)$/i;
const textNotFound = () =>
  new Response("Not found\n", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });

// Decode, collapse slashes and resolve dot segments; null if malformed.
function normalizedPath(url: string): string | null {
  let p: string;
  try {
    p = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

const SESSION_PATHS = [
  "/api/*",
  "/auth/*",
  "/oauth/*",
  "/mcp",
  "/mcp/*",
] as const;

// PUT R.upload(id) is authorized by its signature: no session, no CSRF.
const SIGNED_UPLOAD = /^\/api\/v1\/uploads\/[^/]+$/;
const isSignedUpload = (c: Context<AppEnv>) =>
  c.req.method === "PUT" && SIGNED_UPLOAD.test(c.req.path);
const unlessSigned =
  (mw: MiddlewareHandler<AppEnv>): MiddlewareHandler<AppEnv> =>
  (c, next) =>
    isSignedUpload(c) ? next() : mw(c, next);

/** `extraPolicy`: rules for routes a custom `mount` adds (tests). */
export function createApp(
  mount: (app: AppType) => void = mountRoutes,
  extraPolicy: Readonly<Record<string, Policy>> = {},
) {
  const app: AppType = new Hono<AppEnv>();
  // Outermost: an early refusal cancels the request body nothing read.
  app.use(mw(cancelUnreadOnRefusal()));
  // This invocation's broker capabilities (ctx.props) for the whole request,
  // waitUntil work included (auth/broker-transport.ts).
  app.use(
    mw(async (c, next) => {
      let ctx: { props?: unknown } | undefined;
      try {
        ctx = c.executionCtx;
      } catch {
        ctx = undefined;
      }
      // A fresh credential slot per request (auth/cred.ts): the session read
      // fills it, audit() reads it, and waitUntil work keeps this one.
      // Hosted: the billing plan for every features check (a no-op when the
      // fetch entry already read it).
      return withCredScope(() =>
        withBrokerProps(ctx, () => withPlanScope(c.env, next)),
      );
    }),
  );
  app.use(mw(securityHeaders()));
  // Every route's access rule (auth/route-policy.ts), before any other
  // middleware or handler: an unlisted route is 404 before anything runs.
  app.use("*", enforcePolicy({ ...ROUTE_POLICY, ...extraPolicy }));
  app.onError((e) => toErrorResponse(e));
  app.notFound(() => toErrorResponse(new ApiError("not_found", "Not found")));

  // installId last: exact-shape tests pin the key order. It is the trimmed
  // INSTALL_ID (the same value authConfig uses for keys), and absent (not
  // null) when unset or empty after trimming, so self-host output is
  // unchanged. It proves routing, never authenticity: the control plane must
  // not treat it as an authorization signal. oauthStore (the OAuth store
  // move): the mode, whether a full KV -> D1 copy completed, and since when
  // KV writes are off; one D1 read, no writes (no counts, no keys), and null
  // when D1 can't be read.
  app.get("/healthz", async (c) => {
    const installId = c.env.INSTALL_ID?.trim();
    const oauthStore = await oauthStoreHealth(c.env);
    return c.json({
      ok: true,
      plan: planOf(c.env.PLAN),
      version: VERSION,
      oauthStore,
      // Only where hooks are on (the redline bundle); absent means off, so
      // production's /healthz bytes are unchanged.
      ...(hooks && hooks.testHooksOn(c.env) ? { testHooks: true } : {}),
      ...(installId ? { installId } : {}),
    });
  });
  app.get("/robots.txt", (c) => c.text(APP_ROBOTS));
  // Public, outside SESSION_PATHS: no session read, no D1.
  // /__test/* (P5 hooks): before any session read; 404 unless enabled.
  if (hooks) hooks.mountTestHooks(app);
  // POST /__oa/oauth-store/copy (#1008): before any session read; 404
  // unless OAUTH_COPY_KEY is set (mcp/oauth-copy.ts decides).
  mountOAuthCopy(app);
  app.get(SKILL_PATH, serveSkill);
  app.get(UPGRADE_PATH, serveUpgrade);
  app.get(LLMS_PATH, serveLlms);
  // Public sign-in offering (#359 AuthProviders): config only, before the
  // /auth/* session middleware, so it never touches D1.
  app.get(AUTH.providers, (c) => {
    c.header("cache-control", "no-store");
    return c.json(authProviders(c.env));
  });
  // Ordering: GET (and HEAD, which Hono routes to GET handlers) match above
  // first; app.all only catches the remaining methods.
  app.all("/healthz", methodNotAllowed);
  app.all("/robots.txt", methodNotAllowed);
  app.all(SKILL_PATH, methodNotAllowed);
  app.all(UPGRADE_PATH, methodNotAllowed);
  app.all(LLMS_PATH, methodNotAllowed);

  // c.var.user (Bearer PAT wins over the cookie) for Worker routes only, so
  // SPA/asset requests never touch D1 (beyond the shell's instance-name read). Elsewhere caller() sees anonymous.
  for (const p of SESSION_PATHS) app.use(p, mw(unlessSigned(session())));
  // Cookie-authenticated mutations need X-OA-Request: 1 (PATs exempt).
  app.use("/api/v1/*", mw(unlessSigned(csrf())));
  // Capped callers (guests under direct sign-in) are read-only (P2 T9).
  app.use("/api/v1/*", mw(unlessSigned(readOnlyCap())));
  // Hosted billing: team features under a plan lock (route-policy.ts).
  app.use("/api/v1/*", planGate());
  app.use(AUTH.logout, mw(sameOrigin()), mw(csrf()));

  mount(app);

  // Final fallback (registered last, in one place): SPA from ASSETS for GET/HEAD non-Worker paths.
  // (Requires run_worker_first: true, so the Worker sees every request.)
  app.on(["GET", "HEAD"], "*", async (c) => {
    const path = normalizedPath(c.req.url);
    if (path === null || WORKER_PREFIX.test(path) || !c.env.ASSETS) {
      return toErrorResponse(new ApiError("not_found", "Not found"));
    }
    const bundle = path.startsWith("/assets/");
    const text = TEXT_FILE.test(path);
    if (text && !bundle) return textNotFound();
    // PUBLIC_HOME: a signed-out visitor at exactly "/" goes to a public
    // artifact. Signed in = a valid session cookie (HMAC only, no D1).
    if (
      c.env.PUBLIC_HOME &&
      new URL(c.req.url).pathname === "/" &&
      !(await readSession(c.env, getCookie(c, sessionCookieName(c.env))))
    ) {
      const to = await publicHome(c.env);
      if (to)
        return new Response(null, {
          status: 302,
          headers: { Location: to, "Cache-Control": "no-store" },
        });
    }
    const res = await c.env.ASSETS.fetch(c.req.raw);
    // A missing bundle .txt/.md gets ASSETS' SPA fallback (200 text/html):
    // answer the plain 404 instead. A 304 revalidation passes through.
    if (
      text &&
      (res.status >= 400 ||
        /^text\/html/i.test(res.headers.get("content-type") ?? ""))
    ) {
      await res.body?.cancel();
      return textNotFound();
    }
    return bundle ? res : withInstanceMeta(c.env, res);
  });
  return app;
}

export const app = createApp();
// Build the route matchers now (module scope counts toward the startup limit,
// not a request's CPU): Hono compiles them on the first match, ~2.5 ms of a
// cold isolate's first request. No routes are added after this.
app.router.match("GET", "/");
