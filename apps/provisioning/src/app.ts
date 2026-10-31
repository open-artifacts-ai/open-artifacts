import { ROUTES } from "@oa/shared/provisioning";
import { authenticate } from "./auth/authenticate.js";
import { handleOAuth, isOAuthPath, OAUTH_PATHS } from "./auth/oauth/index.js";
import type { Env } from "./env.js";
import {
  ApiError,
  errorResponse,
  NotImplemented,
  notImplemented,
} from "./errors.js";
import { type HostKind, hostKind } from "./hosts.js";
import { limit } from "./limits.js";
import { handleMcp } from "./mcp/index.js";
import { isRefusal } from "./principal.js";
import { refuse } from "./refuse.js";
import { invokeRoute } from "./routes/invoke.js";
import { matchRoute } from "./routes/table.js";

// The HTTP adapter (design v7 4.2 check order): host policy -> pre-authn IP
// limit -> Origin (W5a) -> authn -> CSRF (W5a) -> invokeRoute.

// W5b replaces this with the shared ipKey (IPv6 by /64, 4.7).
const clientIp = (req: Request) =>
  req.headers.get("cf-connecting-ip") ?? "unknown";

const notFound = () => errorResponse("not_found");

export async function handle(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  const host = hostKind(url.hostname, env);
  if (!host) return notFound();

  const pre = await limit(env, "pre_ip", clientIp(req));
  if (pre) return refuse(env, "pre_ip", pre.code, req);

  // Browser hosts refuse Authorization; api.<app> ignores Cookie (4.5).
  if (host === "admin" && req.headers.has("authorization"))
    return refuse(env, "auth", "unauthenticated", req);

  const path = url.pathname;
  if (path === "/mcp")
    return host === "api" ? handleMcp(req, env, ctx) : notFound();
  if (isOAuthPath(path))
    return (OAUTH_PATHS[host] as readonly string[]).includes(path)
      ? handleOAuth(req, env, ctx)
      : notFound();

  const m = matchRoute(host, req.method, path);
  if (m && ROUTES[m.route].base === "browser") return notImplemented();
  if (m) return apiRoute(req, env, ctx, host, m.route, m.params, url);
  if (
    host === "admin" &&
    !path.startsWith("/api/") &&
    !path.startsWith("/v1/") &&
    !path.startsWith("/auth/")
  )
    return env.ASSETS.fetch(req);
  return notFound();
}

async function apiRoute(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  host: HostKind,
  route: Parameters<typeof invokeRoute>[3],
  params: Record<string, string>,
  url: URL,
): Promise<Response> {
  const p = await authenticate(req, env, host);
  if (isRefusal(p)) return refuse(env, "auth", p.code, req);
  try {
    // W4: content-type, the 16 KiB body cap and JSON parse (3.1).
    const r = await invokeRoute(
      env,
      ctx,
      p,
      route,
      { params, query: Object.fromEntries(url.searchParams) },
      { kind: "http" },
    );
    return new Response(r.body === null ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...r.headers,
      },
    });
  } catch (e) {
    if (e instanceof ApiError)
      return errorResponse(e.code, e.message, e.details);
    if (e instanceof NotImplemented) return notImplemented();
    return errorResponse("internal");
  }
}
