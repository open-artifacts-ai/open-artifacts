import { isId } from "@oa/shared";
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { planError, requireTeamPlan } from "../billing/plan.js";
import { ApiError } from "../http/errors.js";
import { type AppEnv, resolveSession } from "../http/middleware.js";
import {
  accessLevel,
  authorize,
  type Caller,
  caller,
  capOfCaller,
  planOfMember,
  withAccessCache,
} from "./authz.js";
import { authConfig } from "./config.js";
import { orgCan } from "./policy.js";
import {
  CONTENT_POLICY,
  type Policy,
  ROUTE_POLICY,
  TEAM_ROUTES,
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

/**
 * Whether `who` would pass this artifact rule without the billing plan cap
 * (or is refused only by the plan lock itself). Refusals only: one more
 * access read.
 */
async function allowedUncapped(
  env: AppEnv["Bindings"],
  who: Extract<Caller, { kind: "user" }>,
  id: string,
  p: Extract<Policy, { artifact: unknown }>,
): Promise<boolean> {
  try {
    await authorize(env, { ...who, cap: null }, id, p.artifact, {
      allowDeleted: p.allowDeleted,
      ctx: p.ctx,
    });
    return true;
  } catch (e) {
    return (
      e instanceof ApiError &&
      (e.code === "plan_read_only" || e.code === "plan_required")
    );
  }
}

/** Applies one policy for `who`; resolves to nothing or throws (401/404). */
export async function enforce(
  p: Policy | undefined,
  who: Caller,
  env: AppEnv["Bindings"],
  artifactId: () => string,
  /** The request is a write (not GET/HEAD): hosted billing's plan 403 applies. */
  write = true,
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
      // Hosted billing: a member under the plan cap whose role would allow
      // this gets the clear 403, not 404 (they can see the artifact).
      const lock =
        write && who.kind === "user" && who.cap === "plan"
          ? planOfMember(who.user)?.lock
          : null;
      if (
        lock &&
        who.kind === "user" &&
        e instanceof ApiError &&
        e.code === "not_found" &&
        (await allowedUncapped(env, who, id, p))
      )
        throw planError(lock);
      // Keep the handler's order: an anonymous caller who may view gets 401.
      // A data write refused by dataWriters "editors" already threw 403
      // data_editors_only (authorize, #681).
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
    // Hosted billing: an admin under the plan cap gets the clear 403 on a
    // write their role would allow (their admin reads stay 404, as for any
    // capped admin).
    const lock =
      who.cap === "plan" && write ? planOfMember(who.user)?.lock : null;
    if (lock && orgCan(who.user, p.org, { cap: null })) throw planError(lock);
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
      await enforce(
        p,
        who,
        c.env,
        () => paramAt(c, t.index, "id"),
        t.method !== "GET" && t.method !== "HEAD",
      );
      // Hosted billing: the org-level team features under a plan lock.
      const route = `${t.method} ${t.path}`;
      if (who.kind === "user" && TEAM_ROUTES.has(route))
        requireTeamPlan(planOfMember(who.user), {
          invite: route === "POST /api/v1/members",
        });
      await next();
    });
  });
