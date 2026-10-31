import { API_ERROR_STATUS, type ApiRouteId } from "@oa/shared/provisioning";
import { ApiError } from "../src/errors.js";
import type { Principal } from "../src/principal.js";
import {
  invokeRoute,
  type RouteInput,
  type Surface,
} from "../src/routes/invoke.js";
import { ctx, type fakeEnv } from "./fakes.js";

export const HTTP: Surface = {
  kind: "http",
  client: { ip: "192.0.2.1", host: "api.hosted.test" },
};

export type Called = {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary JSON
  body: any;
  headers: Record<string, string>;
  code?: string;
  details?: unknown;
};

/** invokeRoute with refusals rendered as `{ status, code, details }`. */
export async function call(
  e: ReturnType<typeof fakeEnv>,
  p: Principal,
  route: ApiRouteId,
  input: RouteInput = {},
  s: Surface = HTTP,
): Promise<Called> {
  try {
    const r = await invokeRoute(e.env, ctx(), p, route, input, s);
    return { status: r.status, body: r.body, headers: r.headers };
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return {
      status: API_ERROR_STATUS[err.code],
      body: null,
      headers: {},
      code: err.code,
      details: err.details,
    };
  }
}
