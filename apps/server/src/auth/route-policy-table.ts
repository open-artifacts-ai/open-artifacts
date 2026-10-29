import type { ENV_FEATURE_FLAGS } from "@oa/shared";
import type { OrgAction, PolicyAction } from "./policy.js";

// The route, content and tool policy tables. No runtime imports, so Node
// (the P5 red-line suite) can load them; route-policy.ts enforces them.

/** A flag the FEATURES env may set (@oa/shared ENV_FEATURE_FLAGS). */
type EnvFlag = (typeof ENV_FEATURE_FLAGS)[number];

/**
 * Every route's access rule, enforced by `enforcePolicy` before its handler
 * runs (P3 T5). A route with no entry answers 404, so a new route can't ship
 * unguarded. Handlers keep their finer checks (thumbnail first-write, runtime
 * gate kinds, anonymous writes); the gate is the floor they can't skip.
 *
 * - `artifact`: authorize(caller, :id, action) (404 otherwise); `signedIn`
 *   answers 401 first for anonymous callers, as the handler would.
 * - `org`: a signed-in user (401) allowed `orgCan(user, org)` (404).
 *   `offWhen`: 404 for everyone while FEATURES has that flag (a feature
 *   switched off; it can only narrow).
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
  | { org: OrgAction; offWhen?: EnvFlag }
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
  "GET /llms.txt": { public: "AI agent setup guide" },
  "ALL /healthz": { public: "405" },
  "ALL /robots.txt": { public: "405" },
  "ALL /skill.md": { public: "405" },
  "ALL /upgrade.md": { public: "405" },
  "ALL /llms.txt": { public: "405" },
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
  // #1008 the OAuth KV -> D1 copy: 404 unless OAUTH_COPY_KEY is set
  // (mcp/oauth-copy.ts decides; its bearer key is the gate).
  "POST /__oa/oauth-store/copy": {
    public: "OAuth store copy; 404 unless OAUTH_COPY_KEY is set",
  },
  "GET /api/v1/me": { user: "the caller" },
  "PATCH /api/v1/me": { user: "the caller" },
  // #1292: the caller's own share-notice picks; PUT browser sessions only (handler).
  "GET /api/v1/bus/share-notices": { org: "mcp.connect" },
  "PUT /api/v1/bus/share-notices": { org: "mcp.connect" },
  "GET /api/v1/members": { org: "members.manage" },
  "POST /api/v1/members": { org: "members.manage" },
  "PATCH /api/v1/members/:id": { org: "members.manage" },
  "DELETE /api/v1/members/:id": { org: "members.manage" },
  "POST /api/v1/members/:id/restore": { org: "members.manage" },
  // #1204: the handler also requires an interactive cookie session.
  "POST /api/v1/members/:id/erase": { org: "members.manage" },
  // P3 T10: a departed member's artifacts (every install, parity 1).
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
  [`GET ${SPACES}/candidates`]: {
    user: "space manager or org admin, uncapped (the service)",
  },
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
  // P3 T13: the live group lookup (owners and admins, RL_DIRECTORY), "Sync
  // now" and a held sweep's confirmation (org owner).
  "GET /api/v1/directory/groups": { org: "org.mappings" },
  "POST /api/v1/directory/sync": { org: "directory.manage" },
  "POST /api/v1/directory/held/:groupId/confirm": { org: "directory.manage" },
  // #412: snooze a held sweep, and cancel the snooze (org owner).
  "POST /api/v1/directory/held/:groupId/snooze": { org: "directory.manage" },
  "DELETE /api/v1/directory/held/:groupId/snooze": { org: "directory.manage" },
  // Disconnect: the org owner; the handler also refuses bearer auth (an
  // interactive cookie session only). DELETE R.directory is the same,
  // answering 204. The platform's install delete never uses these: it runs
  // the same operation through scheduled() (cron.ts DIRECTORY_DISCONNECT_CRON).
  "POST /api/v1/directory/disconnect": { org: "directory.disconnect" },
  "DELETE /api/v1/directory": { org: "directory.disconnect" },
  // Probes the auth and directory brokers through the real transport: the
  // org owner only (admins too get 404).
  "POST /api/v1/admin/broker-check": { org: "broker.check" },
  // Parity 2: dismiss a notice (R.noticeDismiss). guest_shares: one's own,
  // any non-guest member; guest_summary: install-wide, the org owner only.
  "POST /api/v1/notices/guest_shares/dismiss": { org: "notices.own" },
  "POST /api/v1/notices/guest_summary/dismiss": { org: "notices.manage" },
  "PUT /api/v1/members/:id/restricted": { org: "restricted.member" },
  "DELETE /api/v1/members/:id/restricted": { org: "restricted.member" },
  "PATCH /api/v1/settings": { org: "settings.manage" },
  "GET /api/v1/artifacts": { user: "list, filtered by listFilterSql" },
  "GET /api/v1/trash": {
    user: "trash, filtered by listTrash: own personal plus managed shared spaces",
  },
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
  // P3 T19: hosted sets usage_off (no ANALYTICS_TOKEN there).
  "GET /api/v1/usage": { org: "usage.read", offWhen: "usage_off" },
  // Self-serve billing: the uncapped org owner or admin (404 off hosted, the
  // handler). Each answers only a Stripe URL or this month's count.
  "POST /api/v1/billing/checkout": { org: "billing.manage" },
  "POST /api/v1/billing/portal": { org: "billing.manage" },
  "POST /api/v1/billing/usage": { org: "billing.manage" },
  "GET /api/v1/audit": { org: "audit.read" },
  "GET /api/v1/audit/export": { org: "audit.read" },
  "GET /oauth/authorize": {
    public: "consent page; redirects to sign-in, checks mcp.connect",
  },
  "POST /oauth/authorize": {
    public: "consent decision; checks session and mcp.connect",
  },
  // #1291 the bus. Device flow and the approval page: no session needed or
  // checked by the handler (session, canConnect, the form token); every one
  // 404s while the bus is off. connect: the handler verifies the bus-only
  // machine token (a PAT, an OAuth token or a cookie is 401).
  "POST /bus/device": { public: "bus device flow start; RL_ANON per IP" },
  "POST /bus/device/token": {
    public: "bus device poll; RL_ANON per IP and per code",
  },
  "GET /bus/approve": {
    public:
      "bus code entry (RFC 8628 5.4); redirects to sign-in, checks mcp.connect",
  },
  "POST /bus/approve": {
    public:
      "bus code check and decision; session, form token, mcp.connect, RL per member and IP",
  },
  "GET /bus/connect": { signed: "bus machine token (oa_machine_), D1" },
  // #1300 the member's server-rendered /bus page (bus/page.ts): the handler
  // reads the cookie session (a token is 401, no session redirects to
  // sign-in), checks canConnect or revoke-only, and every POST checks its
  // form token. 404 while the bus is off (busOn false), as the routes above.
  "GET /bus": {
    public:
      "the member's bus page; redirects to sign-in, checks canConnect or revoke-only",
  },
  "GET /bus/machines/:id/revoke": {
    public: "revoke confirm; the caller's own machine only",
  },
  // A capped caller can revoke their own machine (as DELETE R.busMachines).
  "POST /bus/machines/:id/revoke": {
    public: "revoke; form CSRF, the caller's own machine only",
  },
  "POST /bus/share-notices": {
    public: "share notices; form CSRF, checks canConnect",
  },
  "GET /api/v1/bus/machines": { user: "the caller's bus machines" },
  // In CAPPED_ALLOWED: a capped caller can always revoke.
  "DELETE /api/v1/bus/machines/:id": { user: "the caller's bus machines" },
  "GET /api/v1/bus/agents": { org: "mcp.connect" },
  // #1296 role addresses; PUT and DELETE browser sessions only (handler).
  "GET /api/v1/bus/roles": { org: "mcp.connect" },
  "PUT /api/v1/bus/roles": { org: "mcp.connect" },
  "DELETE /api/v1/bus/roles/:id": { org: "mcp.connect" },
  // #1372: the role proposal confirm page (bus/role-confirm.ts). The handler
  // takes only an interactive cookie session of the hub's own member (a
  // PAT, an OAuth grant or a machine token is refused) and a POST its form
  // token; the link's secret finds the proposal in that member's hub only.
  "GET /bus/roles/confirm/:token": {
    public:
      "role proposal confirm page; redirects to sign-in, interactive session, the caller's own hub",
  },
  "POST /bus/roles/confirm/:token": {
    public:
      "role proposal decision; interactive session, form CSRF, the caller's own hub, single use",
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

/**
 * Hosted billing: the org-level team-feature writes. Under a plan lock
 * (billing/plan.ts) the gate refuses them, after the route's own rule, with
 * 403 plan_required (a free, solo instance) or plan_read_only (team
 * features read-only). Removals (DELETE, a suspension or demotion through
 * PATCH members) are never listed: removing people is how a team drops back
 * to free. The first invite on a free instance whose trial never ran passes
 * and starts the trial. Artifact writes in shared spaces, shares, moves and
 * transfers are refused per artifact (policy can, putShare).
 */
export const TEAM_ROUTES: ReadonlySet<string> = new Set([
  "POST /api/v1/members",
  "POST /api/v1/members/:id/transfer",
  "POST /api/v1/spaces",
  `PATCH ${SPACES}`,
  `POST ${SPACES}/members/self`,
  `PUT ${SPACES}/members/:userId`,
  `PUT ${SPACES}/mappings/:groupId`,
  "PUT /api/v1/directory/org-mappings/:groupId",
  "GET /api/v1/directory/connect",
  "POST /api/v1/directory/confirm",
  // Sync now, a held group's confirm, a restricted group: directory sync is
  // a team feature (the cron feed is skipped too: cron.ts).
  "POST /api/v1/directory/sync",
  "POST /api/v1/directory/held/:groupId/confirm",
  "PUT /api/v1/directory/restricted-groups/:groupId",
]);

/**
 * Refused only on a free (solo) instance: a member's role change. On a
 * read-only instance a demotion is how a team drops back, so it passes.
 */
export const SOLO_ROUTES: ReadonlySet<string> = new Set([
  "PATCH /api/v1/members/:id",
]);

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
  undelete_artifact: art("undelete", { allowDeleted: true }),
  artifact_data_get: art("data.read"),
  artifact_data_list: art("data.read"),
  artifact_data_query: art("data.read"),
  artifact_data_set: art("data.write"),
  artifact_data_update: art("data.write"),
  artifact_data_delete: art("data.write"),
  list_spaces: { user: "the caller's own publishable spaces" },
  // #1372: proposes only (the caller's own hub); offered while the bus is on.
  bus_role_propose: { org: "mcp.connect" },
};
