import {
  type AdminToolName,
  authorize,
  ROUTES,
  type RouteId,
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

export type RouteInput = {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
};
export type Surface =
  | { kind: "http" }
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
  route: RouteId,
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
