import {
  type ApiRouteId,
  type BrowserRouteId,
  isApiRoute,
  PROTOCOL_ROUTES,
  ROUTES,
} from "@oa/shared/provisioning";
import { authenticate } from "./auth/authenticate.js";
import { checkCsrf, checkOrigin } from "./auth/csrf.js";
import { handleOAuth, isOAuthPath } from "./auth/oauth/index.js";
import { browserRoute, type SigninDeps } from "./auth/signin.js";
import { LazyBody, readJsonBody } from "./body.js";
import type { Env } from "./env.js";
import {
  ApiError,
  errorResponse,
  methodNotAllowed,
  NotImplemented,
  notImplemented,
} from "./errors.js";
import { browserHeaders } from "./headers.js";
import { type HostKind, hostKind } from "./hosts.js";
import { limit } from "./limits.js";
import { handleMcp } from "./mcp/index.js";
import { isRefusal } from "./principal.js";
import { refuse } from "./refuse.js";
import { bodyKeys, invokeRoute } from "./routes/invoke.js";
import { matchRoute } from "./routes/table.js";
import { ipKeyOf } from "./services/counters.js";

// The HTTP adapter (design v7 4.2 check order): host policy -> pre-authn IP
// limit -> Origin (browser writes) -> authn -> CSRF -> invokeRoute.

// The raw address (Cloudflare sets it on every edge request); rate keys use
// ipKeyOf (IPv6 by /64, 4.7). A request without a parseable one is refused,
// so no two callers ever share an "unknown" bucket.
const clientIp = (req: Request) => req.headers.get("cf-connecting-ip") ?? "";

const notFound = () => errorResponse("not_found");

/** Any throw becomes the 3.5 envelope, never an uncaught Worker 500. */
async function guard(f: () => Promise<Response>): Promise<Response> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ApiError)
      return errorResponse(e.code, e.message, e.details);
    if (e instanceof NotImplemented) return notImplemented();
    return errorResponse("internal");
  }
}

/** `signin`: the sign-in routes' clock and seams (tests only). */
export async function handle(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  signin: Partial<SigninDeps> = {},
): Promise<Response> {
  const url = new URL(req.url);
  const host = hostKind(url.hostname, env);
  if (!host) return notFound();
  if (host === "api") return route(req, env, ctx, "api", url, signin);
  // Every admin-host response, SPA and errors alike, carries the 4.5
  // browser-host headers; the consent page keeps its own CSP (9A.3.2).
  return browserHeaders(await route(req, env, ctx, "admin", url, signin), {
    ownCsp: url.pathname === "/oauth/authorize",
  });
}

async function route(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  host: HostKind,
  url: URL,
  signin: Partial<SigninDeps>,
): Promise<Response> {
  // Host policy first: browser hosts refuse Authorization; api.<app> ignores
  // Cookie (4.5).
  if (host === "admin" && req.headers.has("authorization"))
    return refuse(env, "auth", "unauthenticated", req);

  const ipKey = ipKeyOf(clientIp(req));
  if (ipKey === "unknown") return refuse(env, "pre", "forbidden", req);
  const pre = await limit(env, "pre_ip", ipKey);
  if (pre) return refuse(env, "pre", pre.code, req);

  // Protocol routes: method, path and host from PROTOCOL_ROUTES (9A.3.1).
  // Their own checks (the consent POST's Sec-Fetch-Site, 4.5) replace Origin.
  const path = url.pathname;
  const proto = PROTOCOL_ROUTES.filter((r) => r.path === path);
  if (proto.length > 0) {
    const here = proto.filter((r) => r.host === host);
    if (here.length === 0) return notFound();
    if (!here.some((r) => r.method === req.method))
      return methodNotAllowed(here.map((r) => r.method).join(", "));
    return guard(() =>
      path === "/mcp" ? handleMcp(req, env, ctx) : handleOAuth(req, env, ctx),
    );
  }
  if (isOAuthPath(path)) return notFound();

  // Browser writes: Origin before authn (4.2).
  if (host === "admin") {
    const o = checkOrigin(req, env);
    if (o) return refuse(env, "csrf", o.code, req);
  }

  const m = matchRoute(host, req.method, path);
  if (m)
    return isApiRoute(m.route)
      ? apiRoute(req, env, ctx, host, m.route, m.params, url)
      : guard(() => browserRoute(req, env, m.route as BrowserRouteId, signin));
  if (
    host === "admin" &&
    !path.startsWith("/api/") &&
    !path.startsWith("/v1/") &&
    !path.startsWith("/auth/")
  )
    return guard(() => env.ASSETS.fetch(req));
  return notFound();
}

async function apiRoute(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  host: HostKind,
  route: ApiRouteId,
  params: Record<string, string>,
  url: URL,
): Promise<Response> {
  const p = await authenticate(req, env, host);
  if (isRefusal(p)) return refuse(env, "auth", p.code, req);
  if (host === "admin") {
    const c = checkCsrf(req, env, p);
    if (c) return refuse(env, "csrf", c.code, req);
  }
  return guard(async () => {
    // Writes with a body: application/json, 16 KiB, then JSON (3.1), read
    // by invokeRoute after the rate limit and authz (4.2).
    const def = ROUTES[route];
    const body =
      def.method !== "GET" && bodyKeys(def).size > 0
        ? new LazyBody(() => readJsonBody(req))
        : undefined;
    const r = await invokeRoute(
      env,
      ctx,
      p,
      route,
      { params, query: Object.fromEntries(url.searchParams), body },
      { kind: "http", client: { ip: clientIp(req), host: url.hostname } },
    );
    return new Response(r.body === null ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...r.headers,
      },
    });
  });
}
