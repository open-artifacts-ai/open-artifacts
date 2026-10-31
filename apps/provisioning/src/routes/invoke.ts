import {
  type AdminToolName,
  type ApiRouteId,
  authorize,
  ROUTES,
} from "@oa/shared/provisioning";
import type { Env } from "../env.js";
import { ApiError } from "../errors.js";
import { limit } from "../limits.js";
import type { Principal } from "../principal.js";
import { HANDLERS } from "./handlers.js";

// The one entry point both surfaces call (design v7 9A.4). It runs the
// post-authn part of the 4.2 check order: rate limit -> authz (authz.ts) ->
// schema -> policy -> business -> handler -> audit, and throws ApiError on
// any refusal. C4 wires the limit and authz; W4 adds schema through audit.
// The browser routes (R22-R24: cookies, Set-Cookie, redirects) never come
// here: W5a builds them beside it in src/auth/, and the adapter short-circuits
// them, so the type leaves them out: `route` is ApiRouteId (shared), the
// same type AdminToolDef.route carries, so the MCP adapter passes tool.route.

export type RouteInput = {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
};
/**
 * `client` is what W4's policy step needs and the adapter alone knows: `ip`
 * (cf-connecting-ip; R18's RL_PV_SLUG_IP, the self-serve /64 and /48
 * counters, Turnstile's remoteIp) and `host` (the request hostname,
 * Turnstile's hostname check). MCP carries none: self-serve users get 401
 * on /mcp (4.2).
 */
export type Surface =
  | { kind: "http"; client: { ip: string; host: string } }
  | { kind: "mcp"; tool: AdminToolName; clientVersion: string | null };
export type RouteResult = {
  status: number;
  body: unknown;
  headers: Record<string, string>;
};

export async function invokeRoute(
  env: Env,
  ctx: ExecutionContext,
  principal: Principal,
  route: ApiRouteId,
  input: RouteInput,
  surface: Surface,
): Promise<RouteResult> {
  const r = await limit(
    env,
    ROUTES[route].write ? "write" : "read",
    principal.rateKey,
  );
  if (r) throw new ApiError(r.code);
  const d = authorize(route, principal, env.OA_ENV);
  if (!d.ok) throw new ApiError(d.code);
  return HANDLERS[route]({
    env,
    ctx,
    principal,
    input,
    surface,
    reach: d.reach,
  });
}
