import type { ApiRouteId } from "@oa/shared/provisioning";
import type { Env } from "../env.js";
import type { Principal } from "../principal.js";
import { recordTokenUse } from "../services/tokens.js";
import type { Surface } from "./invoke.js";

export type AuthenticatedCall = {
  env: Env;
  ctx: ExecutionContext;
  principal: Principal;
  route: ApiRouteId;
  surface: Surface;
};

/**
 * invokeRoute's one hook (9A.4): runs once per call that authz admitted,
 * before schema, on both surfaces. W5b's `token.used` audit (4.9) plugs in
 * here, off the response path (ctx.waitUntil), without editing invokeRoute.
 * A throw never fails the call (invokeRoute drops it).
 */
export function onAuthenticated(c: AuthenticatedCall): void {
  // A failed write never fails the call, nor surfaces as unhandled.
  c.ctx.waitUntil(
    recordTokenUse(c.env, c.principal, c.route, c.surface).catch(() => {}),
  );
}
