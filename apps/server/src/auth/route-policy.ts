import { isId } from "@oa/shared";
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { ApiError } from "../http/errors.js";
import { type AppEnv, resolveSession } from "../http/middleware.js";
import {
  accessLevel,
  authorize,
  type Caller,
  caller,
  capOfCaller,
  withAccessCache,
} from "./authz.js";
import { authConfig } from "./config.js";
import { orgCan } from "./policy.js";
import {
  CONTENT_POLICY,
  type Policy,
  ROUTE_POLICY,
} from "./route-policy-table.js";

export {
  CONTENT_POLICY,
  OAUTH_PROVIDER_ROUTES,
  type Policy,
  ROUTE_POLICY,
  TOOL_POLICY,
} from "./route-policy-table.js";

/**
 * Real middleware, tagged at registration (`mw`). The gate skips exactly
 * these when it looks for the route that will answer; anything else matched
 * is a handler and needs a policy.
 */
const MIDDLEWARE = new WeakSet<object>();
export function mw<T extends object>(handler: T): T {
  MIDDLEWARE.add(handler);
  return handler;
}
export const isMiddleware = (handler: object): boolean =>
  MIDDLEWARE.has(handler);


type Target = { method: string; path: string; index: number };

/**
 * The route that will answer: the first matched route after this middleware
 * that is a handler (middleware are `ALL` routes taking `(c, next)`).
 */
export function targetRoute(c: Context): Target | null {
  const routes = matchedRoutes(c);
  for (let i = c.req.routeIndex + 1; i < routes.length; i++) {
    const r = routes[i];
    if (!r) continue;
    if (isMiddleware(r.handler)) continue;
    return { method: r.method, path: r.path, index: i };
  }
  return null;
}

function paramAt(c: Context, index: number, name: string): string {
  const prev = c.req.routeIndex;
  c.req.routeIndex = index;
  try {
    return c.req.param(name) ?? "";
  } finally {
    c.req.routeIndex = prev;
  }
}

const notFound = () => new ApiError("not_found", "Not found");

/** Applies one policy for `who`; resolves to nothing or throws (401/404). */
export async function enforce(
  p: Policy | undefined,
  who: Caller,
  env: AppEnv["Bindings"],
  artifactId: () => string,
): Promise<void> {
  if (!p) throw notFound();
  if ("public" in p || "signed" in p) return;
  if ("artifact" in p) {
    if (p.signedIn && who.kind !== "user")
      throw new ApiError("unauthorized", "Sign in required");
    const id = artifactId();
    // Malformed ids never reach D1.
    if (!isId(id)) throw notFound();
    try {
      await authorize(env, who, id, p.artifact, {
        allowDeleted: p.allowDeleted,
        prefetch: true,
        ctx: p.ctx,
      });
    } catch (e) {
      // Keep the handler's order: an anonymous caller who may view gets 401.
      if (
        p.anon401 &&
        who.kind !== "user" &&
        e instanceof ApiError &&
        e.code === "not_found" &&
        (await accessLevel(env, who, id))
      )
        throw new ApiError("unauthorized", p.anon401);
      throw e;
    }
    return;
  }
  // A switched-off feature is absent for everyone, signed in or not.
  if ("org" in p && p.offWhen && authConfig(env).features.includes(p.offWhen))
    throw notFound();
  if (who.kind !== "user")
    throw new ApiError("unauthorized", "Sign in required");
  if ("org" in p && !orgCan(who.user, p.org, { cap: capOfCaller(who) })) {
    // #359: any create by a capped caller (guests under direct sign-in, P3's
    // restricted members) is 403 space_forbidden, never 404.
    if (p.org === "artifact.create" && capOfCaller(who))
      throw new ApiError("space_forbidden", "Guests can't publish here");
    throw notFound();
  }
}

/**
 * Content-host gate: every route is public or signed (the handlers verify
 * tokens and visibility), so this only refuses a route with no entry.
 */
export const enforceContentPolicy = (): MiddlewareHandler =>
  mw(async (c, next) => {
    const t = targetRoute(c);
    if (t && !CONTENT_POLICY[`${t.method} ${t.path}`]) throw notFound();
    await next();
  });

/** App-host gate: looks the answering route up in `table` and enforces it. */
export const enforcePolicy = (
  table: Readonly<Record<string, Policy>> = ROUTE_POLICY,
): MiddlewareHandler<AppEnv> =>
  mw(async (c, next) => {
    // Before any session or access read (live socket revocation).
    c.set("authzAt", Date.now());
    const t = targetRoute(c);
    // No answering route: the app's notFound handler answers 404.
    if (!t) return next();
    const p = table[`${t.method} ${t.path}`];
    if (!p) throw notFound();
    // Registered first, so it reads the session itself when a rule needs a
    // caller (session() later is then a no-op).
    if (!("public" in p || "signed" in p)) await resolveSession(c);
    const who: Caller =
      c.req.header("x-oa-embed") === "1" ? { kind: "anonymous" } : caller(c);
    await withAccessCache(async () => {
      await enforce(p, who, c.env, () => paramAt(c, t.index, "id"));
      await next();
    });
  });
