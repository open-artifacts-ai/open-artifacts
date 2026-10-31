import type { ApiRouteId } from "@oa/shared/provisioning";
import type { Env } from "../env.js";
import { NOT_IMPLEMENTED_BODY } from "../errors.js";
import type { Principal } from "../principal.js";
import type { RouteInput, RouteResult, Surface } from "./invoke.js";
import { listTokensHandler, mintToken, revokeTokens } from "./tokens.js";
import { world } from "./world.js";

/** What a handler gets once invokeRoute has passed authz. */
export type HandlerArgs = {
  env: Env;
  ctx: ExecutionContext;
  principal: Principal;
  input: RouteInput;
  surface: Surface;
  /** The authz row's reach: "own" scopes the handler to the principal's installs. */
  reach: "all" | "own";
};
export type Handler = (a: HandlerArgs) => Promise<RouteResult>;

/** The C4 stub: 501 until W4 (R1-R21, R25, R26) lands. */
export const stub: Handler = async () => ({
  status: 501,
  body: NOT_IMPLEMENTED_BODY,
  headers: {},
});

export const HANDLERS: Readonly<Record<ApiRouteId, Handler>> = {
  R1: stub,
  R2: stub,
  R3: stub,
  R4: stub,
  R5: stub,
  R6: stub,
  R7: stub,
  R8: stub,
  R9: stub,
  R10: stub,
  R11: stub,
  R12: stub,
  R13: stub,
  R14: stub,
  R15: stub,
  R16: stub,
  R17: stub,
  R18: stub,
  R19: mintToken,
  R20: listTokensHandler,
  R21: revokeTokens,
  R25: stub,
  R26: stub,
  R27: world,
};
