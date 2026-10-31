import type { ApiRouteId } from "@oa/shared/provisioning";
import type { Env } from "../env.js";
import { NOT_IMPLEMENTED_BODY } from "../errors.js";
import type { Principal } from "../principal.js";
import { createInstall } from "./create.js";
import type { RouteInput, RouteResult, Surface } from "./invoke.js";
import {
  checkSlug,
  getInstall,
  getJob,
  listInstalls,
  listJobs,
  listReleases,
  me,
  queryAudit,
} from "./reads.js";
import { world } from "./world.js";
import { cancelJob, lifecycleWrite } from "./writes.js";

/** What a handler gets once invokeRoute has passed authz and the schema. */
export type HandlerArgs = {
  env: Env;
  ctx: ExecutionContext;
  principal: Principal;
  route: ApiRouteId;
  /** The route's params, query and body after its zod parse (defaults applied). */
  input: RouteInput;
  surface: Surface;
  /** The authz row's reach: "own" scopes the handler to the principal's installs. */
  reach: "all" | "own";
};
export type Handler = (a: HandlerArgs) => Promise<RouteResult>;

/** The C4 stub: 501 until W5b lands the token routes (R19-R21). */
export const stub: Handler = async () => ({
  status: 501,
  body: NOT_IMPLEMENTED_BODY,
  headers: {},
});

export const HANDLERS: Readonly<Record<ApiRouteId, Handler>> = {
  R1: me,
  R2: listInstalls,
  R3: getInstall,
  R4: createInstall,
  R5: lifecycleWrite,
  R6: lifecycleWrite,
  R7: lifecycleWrite,
  R8: lifecycleWrite,
  R9: lifecycleWrite,
  R10: lifecycleWrite,
  R11: lifecycleWrite,
  R12: lifecycleWrite,
  R13: lifecycleWrite,
  R14: listJobs,
  R15: getJob,
  R16: listReleases,
  R17: queryAudit,
  R18: checkSlug,
  R19: stub,
  R20: stub,
  R21: stub,
  R25: cancelJob,
  R26: lifecycleWrite,
  R27: world,
};
