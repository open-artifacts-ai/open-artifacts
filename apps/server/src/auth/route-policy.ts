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
import { type OrgAction, orgCan, type PolicyAction } from "./policy.js";

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

/**
 * Every route's access rule, enforced by `enforcePolicy` before its handler
 * runs (P3 T5). A route with no entry answers 404, so a new route can't ship
 * unguarded. Handlers keep their finer checks (thumbnail first-write, runtime
 * gate kinds, anonymous writes); the gate is the floor they can't skip.
 *
 * - `artifact`: authorize(caller, :id, action) (404 otherwise); `signedIn`
 *   answers 401 first for anonymous callers, as the handler would.
 * - `org`: a signed-in user (401) allowed `orgCan(user, org)` (404).
 * - `user`: any signed-in user (401); the handler scopes to the caller's own rows.
 * - `public` / `signed`: no session needed (signed: verified by the handler).
 */
export type Policy =
  | {
      artifact: PolicyAction;
      signedIn?: true;
      allowDeleted?: true;
      /** Anonymous callers who can view get this 401 instead of 404 (the handler's order). */
      anon401?: string;
      /** Floor context for viewer thumbnails (the handler applies the exact rule). */
      ctx?: { firstThumbnail?: boolean };
    }
  | { org: OrgAction }
  | { user: string }
  | { public: string }
  | { signed: string };

const art = (
  action: PolicyAction,
  extra: {
    signedIn?: true;
    allowDeleted?: true;
    anon401?: string;
    ctx?: { firstThumbnail?: boolean };
  } = {},
): Policy => ({ artifact: action, ...extra });
const SAVE = "Sign in to save changes";
const ARTS = "/api/v1/artifacts/:id";
const SPACES = "/api/v1/spaces/:id";
const signedIn = { signedIn: true } as const;

/** App host routes, keyed `${method} ${path}` as Hono registers them. */
export const ROUTE_POLICY: Readonly<Record<string, Policy>> = {
  "GET /healthz": { public: "health probe" },
  "GET /robots.txt": { public: "robots" },
  "GET /skill.md": { public: "agent skill" },
  "GET /upgrade.md": { public: "upgrade guide" },
  "ALL /healthz": { public: "405" },
  "ALL /robots.txt": { public: "405" },
  "ALL /skill.md": { public: "405" },
  "ALL /upgrade.md": { public: "405" },
  "GET /auth/providers": {
    public: "sign-in offering; config only, never D1",
  },
  "GET /auth/login": { public: "sign-in start" },
  "GET /auth/callback": { public: "sign-in callback" },
  "GET /auth/login/google": { public: "sign-in start (Google)" },
  "GET /auth/callback/google": { public: "sign-in callback (Google)" },
  // Emailed codes: no session yet; the login guard (X-OA-Request, JSON,
  // same-origin) and the pending code cookie carry the protection.
  "POST /auth/code/request": { public: "code request; login guard, Turnstile" },
  "POST /auth/code/verify": { public: "code verify; login guard" },
  "POST /auth/logout": { public: "sign-out (same-origin, CSRF)" },
  "GET /auth/dev-login": { public: "dev only; refused outside dev" },
  // P2 test hooks: 404 unless TEST_HOOKS is on (test-hooks/index.ts decides).
  "ALL /__test/*": { public: "test hooks; 404 unless TEST_HOOKS is on" },
  "GET /api/v1/me": { user: "the caller" },
  "PATCH /api/v1/me": { user: "the caller" },
  "GET /api/v1/members": { org: "members.manage" },
  "POST /api/v1/members": { org: "members.manage" },
  "PATCH /api/v1/members/:id": { org: "members.manage" },
  "DELETE /api/v1/members/:id": { org: "members.manage" },
  // P3 T10: a departed member's artifacts (404 without the spaces feature).
  "GET /api/v1/members/:id/transfer": { org: "transfer.departed" },
  "POST /api/v1/members/:id/transfer": { org: "transfer.departed" },
  // The handler requires a manager and 404s for the owner's own link.
  "DELETE /api/v1/members/:id/identities/google": { org: "members.manage" },
  "GET /api/v1/settings": { org: "settings.read" },
  // P3 T9 spaces API: 404 without the spaces feature. Space routes admit any
  // signed-in caller; the service applies the per-space rule (member, the
  // space's manager, or an org admin; 404 otherwise, never 403 except the
  // contract's space_forbidden and directory_mapping_off).
  "GET /api/v1/spaces": { user: "spaces the caller can see" },
  "POST /api/v1/spaces": { org: "space.create" },
  [`GET ${SPACES}`]: { user: "member or org admin (the service)" },
  [`PATCH ${SPACES}`]: { user: "space manager or org admin (the service)" },
  [`DELETE ${SPACES}`]: { user: "org admin; personal 400 first (the service)" },
  [`GET ${SPACES}/members`]: { user: "member or org admin (the service)" },
  [`POST ${SPACES}/members/self`]: { org: "space.adminSelfAdd" },
  [`PUT ${SPACES}/members/:userId`]: {
    user: "space manager or org admin (the service)",
  },
  [`DELETE ${SPACES}/members/:userId`]: {
    user: "space manager or org admin (the service)",
  },
  [`GET ${SPACES}/mappings`]: {
    user: "space manager or org admin (the service)",
  },
  [`PUT ${SPACES}/mappings/:groupId`]: {
    user: "space manager (viewer, editor) or org admin (the service)",
  },
  [`DELETE ${SPACES}/mappings/:groupId`]: {
    user: "space manager (viewer, editor) or org admin (the service)",
  },
  "GET /api/v1/directory/org-mappings": { org: "org.mappings" },
  "PUT /api/v1/directory/org-mappings/:groupId": { org: "org.mappings" },
  "DELETE /api/v1/directory/org-mappings/:groupId": { org: "org.mappings" },
  "GET /api/v1/directory/restricted-groups": { org: "restricted.groups" },
  "PUT /api/v1/directory/restricted-groups/:groupId": {
    org: "restricted.groups",
  },
  "DELETE /api/v1/directory/restricted-groups/:groupId": {
    org: "restricted.groups",
  },
  // P3 T12: the directory connection. GET status: owners and admins (the
  // problem string for owners only). The callback admits any signed-in
  // caller so a refusal still redirects with ?error= and an audit row; the
  // handler refuses all but the org owner (directory.manage).
  "GET /api/v1/directory": { org: "members.manage" },
  "GET /api/v1/directory/connect": { org: "directory.manage" },
  "GET /api/v1/directory/callback": {
    user: "org owner (the handler); refusals redirect with ?error=",
  },
  // The service also requires the owner who started the connect (404).
  "POST /api/v1/directory/confirm": { org: "directory.manage" },
  "POST /api/v1/directory/cancel": { org: "directory.manage" },
  "PUT /api/v1/members/:id/restricted": { org: "restricted.member" },
  "DELETE /api/v1/members/:id/restricted": { org: "restricted.member" },
  "PATCH /api/v1/settings": { org: "settings.manage" },
  "GET /api/v1/artifacts": { user: "list, filtered by listFilterSql" },
  "POST /api/v1/artifacts": {
    org: "artifact.create",
  },
  [`GET ${ARTS}`]: art("view"),
  [`PATCH ${ARTS}`]: art("publish", signedIn),
  [`DELETE ${ARTS}`]: art("delete", signedIn),
  [`POST ${ARTS}/undelete`]: art("undelete", {
    signedIn: true,
    allowDeleted: true,
  }),
  // P3 T10 (404 without the spaces feature); the service checks the target
  // space (publishTarget).
  [`POST ${ARTS}/move`]: art("move", signedIn),
  [`POST ${ARTS}/transfer`]: art("transfer", signedIn),
  [`GET ${ARTS}/content-url`]: art("content.mint"),
  [`GET ${ARTS}/versions`]: art("versions"),
  [`POST ${ARTS}/versions`]: art("publish", signedIn),
  [`GET ${ARTS}/versions/:v/files/*`]: art("version.file"),
  [`POST ${ARTS}/versions/:v/restore`]: art("restore", signedIn),
  [`PUT ${ARTS}/versions/:v/text`]: art("version.text", signedIn),
  [`GET ${ARTS}/thumbnail`]: art("thumbnail.read"),
  // Viewers may set only the first thumbnail: the floor lets an eligible
  // viewer through and putThumbnail applies the exact rule.
  [`PUT ${ARTS}/thumbnail`]: art("thumbnail.write", {
    signedIn: true,
    ctx: { firstThumbnail: true },
  }),
  [`GET ${ARTS}/shares`]: art("share", signedIn),
  [`PUT ${ARTS}/shares`]: art("share", signedIn),
  [`DELETE ${ARTS}/shares/:email`]: art("unshare", signedIn),
  "POST /api/v1/uploads": { user: "authorizes the target artifact itself" },
  "PUT /api/v1/uploads/:uploadId": { signed: "upload URL signature" },
  "GET /api/v1/search": { user: "search, filtered by listFilterSql" },
  // Runtime: the floor is read access; gate() applies the write, storage and
  // anonymous rules (401s and capability_denied) on top.
  [`GET ${ARTS}/anon-id`]: art("view"),
  [`GET ${ARTS}/data/:col`]: art("data.read"),
  [`GET ${ARTS}/data-count/:col`]: art("data.read"),
  [`POST ${ARTS}/data/:col/query`]: art("data.read"),
  [`GET ${ARTS}/data/:col/:doc`]: art("data.read"),
  [`PUT ${ARTS}/data/:col/:doc`]: art("data.write", { anon401: SAVE }),
  [`PATCH ${ARTS}/data/:col/:doc`]: art("data.write", { anon401: SAVE }),
  [`DELETE ${ARTS}/data/:col/:doc`]: art("data.write", { anon401: SAVE }),
  [`PUT ${ARTS}/data`]: art("data.reset"),
  [`GET ${ARTS}/data-subscribe`]: art("subscribe"),
  [`GET ${ARTS}/events`]: art("events"),
  [`GET ${ARTS}/storage`]: art("storage", { anon401: SAVE }),
  [`GET ${ARTS}/storage/:key`]: art("storage", { anon401: SAVE }),
  [`PUT ${ARTS}/storage/:key`]: art("storage", { anon401: SAVE }),
  [`DELETE ${ARTS}/storage/:key`]: art("storage", { anon401: SAVE }),
  "GET /api/v1/tokens": { user: "the caller's tokens" },
  "POST /api/v1/tokens": { org: "tokens.create" },
  "PATCH /api/v1/tokens/:id": { user: "the caller's tokens" },
  "DELETE /api/v1/tokens/:id": { user: "the caller's tokens" },
  "GET /api/v1/usage": { org: "usage.read" },
  "GET /api/v1/audit": { org: "audit.read" },
  "GET /api/v1/audit/export": { org: "audit.read" },
  "GET /oauth/authorize": {
    public: "consent page; redirects to sign-in, checks mcp.connect",
  },
  "POST /oauth/authorize": {
    public: "consent decision; checks session and mcp.connect",
  },
  "GET /api/v1/oauth-clients": { user: "the caller's grants" },
  "PATCH /api/v1/oauth-clients/:grantId": { user: "the caller's grants" },
  "DELETE /api/v1/oauth-clients/:grantId": { user: "the caller's grants" },
  "GET /a/:id": { public: "SPA shell; OG metadata only for public artifacts" },
  "GET /a/:id/full": { public: "SPA shell" },
  "GET /a/:id/v/:v": { public: "SPA shell" },
  "GET /*": { public: "SPA and assets" },
  "HEAD /*": { public: "SPA and assets" },
};

/** Content host routes: the handlers verify signed tokens or public visibility. */
export const CONTENT_POLICY: Readonly<Record<string, Policy>> = {
  "GET /robots.txt": { public: "robots" },
  "ALL /robots.txt": { public: "405" },
  "GET /_oa/*": { public: "render bundles" },
  "GET /*": { signed: "/c/ signed token or /p/ public visibility" },
};

/**
 * Served by the OAuth provider before the app sees the request (index.ts
 * serveAppHost): listed for the record, public by protocol.
 */
export const OAUTH_PROVIDER_ROUTES: readonly string[] = [
  "POST /oauth/token",
  "POST /oauth/register",
  "GET /.well-known/oauth-authorization-server",
  "GET /.well-known/oauth-protected-resource",
  "POST /mcp",
];

/** MCP tools: `artifact` policies check the tool's `id` input first. */
export const TOOL_POLICY: Readonly<Record<string, Policy>> = {
  publish_artifact: { org: "artifact.create" },
  create_upload: { user: "authorizes the target artifact itself" },
  get_artifact: art("view"),
  list_artifacts: { user: "filtered by listFilterSql" },
  search_artifacts: { user: "filtered by listFilterSql" },
  list_versions: art("versions"),
  restore_version: art("restore"),
  share_artifact: art("share"),
  unshare_artifact: art("unshare"),
  set_visibility: art("visibility"),
  delete_artifact: art("delete"),
  artifact_data_get: art("data.read"),
  artifact_data_list: art("data.read"),
  artifact_data_query: art("data.read"),
  artifact_data_set: art("data.write"),
  artifact_data_update: art("data.write"),
  artifact_data_delete: art("data.write"),
  list_spaces: { user: "the caller's own publishable spaces" },
};

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
