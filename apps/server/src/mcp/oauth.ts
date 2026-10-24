import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
} from "@cloudflare/workers-oauth-provider";
import {
  ApprovedFromSchema,
  AUTH,
  MCP_PATH,
  type Member,
  type OAuthClient,
  OAuthClientPatchSchema,
  R,
  RedirectKindSchema,
  stripNameControls,
} from "@oa/shared";
import type { Context } from "hono";
import { callerOf, capOfCaller, requireUser } from "../auth/authz.js";
import { orgCan } from "../auth/policy.js";
import type { Env } from "../env.js";
import { jsonBody, readCappedRequest } from "../http/body.js";
import { ApiError, errorJson } from "../http/errors.js";
import { FAVICON_TAGS } from "../http/head.js";
import type { AppEnv } from "../http/middleware.js";
import { logError } from "../log.js";
import type { AppType } from "../routes/index.js";
import { ipKey } from "../runtime/routes.js";
import {
  type AgentAttr,
  clientVersionOf,
  dropGrantUsage,
  type GrantIdentity,
  grantUsage,
  pruneGrantUsage,
  redirectInfo,
  setGrantLabel,
  touchGrant,
  uaFamily,
} from "../services/agent-usage.js";
import { getSettings } from "../services/members.js";
import { getUser, getUserWithEpoch } from "../services/users.js";
import { hmacSign, hmacVerify } from "../util/crypto.js";
import { CONSENT_TEMPLATE } from "./consent-template.js";
import {
  OAUTH,
  oauthApi,
  type ProviderOptions,
  providerOptions,
} from "./oauth-api.js";
import {
  markClientGranted,
  registrationAllowed,
  trackRegisteredClient,
} from "./registrations.js";
import {
  capMcpBody,
  createServer,
  mcpHandler,
  mcpResource,
  mcpUnauthorized,
} from "./server.js";
import { escapeHtml, fillTemplate } from "./template.js";

export { OAUTH, oauthApi } from "./oauth-api.js";

/** What a grant carries to the MCP handler (ctx.props) and in its metadata. */
export type GrantProps = {
  userId: string;
  clientName: string;
  /** When consent was approved (ms); compared with users.status_changed_at. */
  issuedAt?: number;
};

const MAX_CLIENT_NAME = 64;
/** Client registrations per IP (IPv6: per /64) per window of RL_ANON. */
const REGISTER_KEY = "reg:ip:";
/** Token requests (grants and revocations) per IP (IPv6: per /64) per RL_ANON window. */
const TOKEN_IP_KEY = "tok:ip:";
/** Consent page renders (beginConsent: a KV write) per user per RL_ANON window. */
const CONSENT_KEY = "consent:u:";
const MAX_TOKEN_BODY = 16 * 1024;
const CSRF_TTL_S = 600;
const MAX_FORM_BYTES = 8 * 1024;
const MAX_GRANTS_LISTED = 100;
const GRANT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Controls, bidi overrides/isolates and zero-width characters: they can disguise a name. */
const HIDDEN_CHARS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** The client's self-asserted name, made safe to show and store (≤ 64 chars). */
export const clientNameOf = (name: string | undefined, fallback: string) =>
  (name?.replace(HIDDEN_CHARS, "").trim() || fallback)
    .replace(HIDDEN_CHARS, "")
    .slice(0, MAX_CLIENT_NAME);

/** Members only, and never a capped caller (a guest, a code session outside the domains, P3's restricted). */
const canConnect = (user: Member) =>
  orgCan(user, "mcp.connect", { cap: capOfCaller(callerOf(user)) });

/** What the grant's KV metadata holds (identity fields absent on grants from before them). */
type GrantMetadata = { clientName?: string } & Partial<GrantIdentity>;

/** The grant id of a provider access token (`{userId}:{grantId}:{secret}`). */
const grantIdOf = (token: string | undefined): string | null => {
  const id = token?.split(":")[1];
  return id && GRANT_ID.test(id) ? id : null;
};

/**
 * Bearer OAuth access tokens at /mcp: the grant's user, attributed to the
 * registered client name and the MCP clientInfo.version. Each request records
 * the grant's use in waitUntil (touchGrant: at most one write a minute).
 */
const apiHandler = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const props = (ctx as ExecutionContext & { props?: Partial<GrantProps> })
      .props;
    const row = props?.userId
      ? await getUserWithEpoch(env, props.userId)
      : null;
    // A grant issued at or before the user's last status change (or with no
    // issuedAt, from before P3 T6) is refused: one minted during a
    // suspension, or missed by the KV revocation, never outlives it.
    if (
      !row ||
      (row.statusChangedAt !== null &&
        !((props?.issuedAt ?? 0) > row.statusChangedAt))
    )
      return mcpUnauthorized(env);
    const { user } = row;
    // A member demoted to guest loses agent access (grants are also revoked).
    if (!canConnect(user))
      return mcpUnauthorized(env, "Only members can connect agents");
    const capped = await capMcpBody(req, env);
    if (capped instanceof Response) return capped;
    const grantId = grantIdOf(
      (ctx as ExecutionContext & { auth?: { token?: string } }).auth?.token,
    );
    const agent: AgentAttr = {
      name: props?.clientName || "unknown agent",
      version: null,
      ...(grantId ? { via: { kind: "grant" as const, id: grantId } } : {}),
    };
    let server: ReturnType<typeof createServer> | undefined;
    const res = await mcpHandler(env, () => {
      server = createServer({
        env,
        user,
        sessionEpoch: row.sessionEpoch,
        agent,
        exec: ctx,
        clientVersion: true,
      });
      return server;
    })(capped, env, ctx);
    if (grantId) {
      const version = clientVersionOf(
        server?.server.getClientVersion()?.version,
      );
      ctx.waitUntil(
        touchGrant(env, grantId, user.id, version).catch((e) =>
          logError("grant_touch_failed", e),
        ),
      );
    }
    return res;
  },
};

/** Providers per app instance (the defaultHandler) and resource URL (env-derived). */
const providers = new WeakMap<object, Map<string, OAuthProvider<Env>>>();

/**
 * The app host's provider: /mcp (OAuth bearer) → apiHandler; /oauth/token,
 * /oauth/register and /.well-known/* are the provider's; everything else → app.
 * Built once per isolate for each (app, resource).
 */
export function oauthProvider(
  env: Env,
  app: ProviderOptions["defaultHandler"],
): OAuthProvider<Env> {
  let byResource = providers.get(app);
  if (!byResource) {
    byResource = new Map();
    providers.set(app, byResource);
  }
  const key = mcpResource(env);
  let p = byResource.get(key);
  if (!p) {
    p = new OAuthProvider<Env>(providerOptions(env, apiHandler, app));
    byResource.set(key, p);
  }
  return p;
}

// Module-scope warm-up (startup limit, not a request's CPU): the first
// OAuthProvider construction compiles its validation code, ~1 ms of a cold
// isolate's first request. The real provider needs env, so it stays lazy;
// this one uses a placeholder host and is discarded.
new OAuthProvider<Env>(
  providerOptions(
    { APP_HOST: "warmup.invalid", ENVIRONMENT: "production" } as Env,
    apiHandler,
    apiHandler,
  ),
);

/**
 * Dynamic client registration is unauthenticated and each one is a KV write
 * (Free plan: 1000/day): RL_ANON per client IP (`reg:ip:<ipKey>`, IPv6 per /64),
 * then an instance-wide daily cap in D1. Without the RL_ANON binding it fails
 * closed, except in dev (where only the daily cap applies).
 */
async function registrationLimited(
  req: Request,
  env: Env,
): Promise<Response | null> {
  if (req.method !== "POST" || new URL(req.url).pathname !== OAUTH.register)
    return null;
  const rl = env.RL_ANON as RateLimit | undefined;
  if (!rl && env.ENVIRONMENT !== "dev")
    return errorJson(503, "internal", "Client registration is unavailable");
  if (rl) {
    const ip = ipKey(req.headers.get("cf-connecting-ip") ?? "") ?? "unknown";
    const { success } = await rl.limit({ key: REGISTER_KEY + ip });
    if (!success)
      return errorJson(
        429,
        "rate_limited",
        "Too many client registrations",
        undefined,
        { "retry-after": "60" },
      );
  }
  // Instance-wide daily cap (D1, read only: rejected attempts write nothing).
  if (!(await registrationAllowed(env)))
    return errorJson(
      429,
      "rate_limited",
      "registration limit reached; try tomorrow",
    );
  return null;
}

/** OAuth-style JSON error for the token endpoint (RFC 6749 §5.2 shape). */
const tokenError = (status: number, error: string, description: string) =>
  new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(status === 429 ? { "retry-after": "60" } : {}),
    },
  });

const isTokenRequest = (req: Request) =>
  req.method === "POST" && new URL(req.url).pathname === OAUTH.token;

/**
 * /oauth/token before the provider: bodies over 16 KB → 413 (a body without
 * a numeric Content-Length is read through a capped reader and re-attached), then
 * RL_ANON per IP (`tok:ip:<ipKey>`) on every request, revocations included:
 * keyed on the caller, it cannot drain anyone else's bucket. Without RL_ANON
 * it fails closed outside dev. The per-client limit runs inside the provider,
 * after authentication (tokenExchangeCallback in oauth-api.ts).
 */
async function tokenGate(req: Request, env: Env): Promise<Request | Response> {
  const rl = env.RL_ANON as RateLimit | undefined;
  if (!rl && env.ENVIRONMENT !== "dev")
    return tokenError(
      503,
      "temporarily_unavailable",
      "Token endpoint is unavailable",
    );
  const tooLarge = () =>
    tokenError(413, "invalid_request", "Token request body is too large");
  let gated = req;
  const declared = req.headers.get("content-length") ?? "";
  if (/^\d+$/.test(declared)) {
    if (Number(declared) > MAX_TOKEN_BODY) return tooLarge();
  } else {
    try {
      const body = await readCappedRequest(req, MAX_TOKEN_BODY);
      gated = new Request(req, { body: body as Uint8Array<ArrayBuffer> });
    } catch {
      return tooLarge();
    }
  }
  if (!rl) return gated;
  const ip = ipKey(req.headers.get("cf-connecting-ip") ?? "") ?? "unknown";
  if ((await rl.limit({ key: TOKEN_IP_KEY + ip })).success) return gated;
  return tokenError(
    429,
    "temporarily_unavailable",
    "Too many token requests; try again in a minute",
  );
}

const NO_TOKEN_HINT =
  "No token sent. Check that your MCP client actually sends the token (a client running as a background service may not see your shell's environment), or connect with OAuth instead.";

/**
 * The provider's 401 at /mcp when no bearer token parses has an empty body;
 * clients then show only "HTTP 401". Adds an RFC 6750-style JSON body and keeps
 * the provider's headers (the WWW-Authenticate OAuth discovery challenge) as is.
 * Missing header → invalid_token; empty `Bearer` or a malformed header → invalid_request.
 */
function explainNoToken(req: Request, res: Response): Response {
  const path = new URL(req.url).pathname;
  if (path !== MCP_PATH && !path.startsWith(`${MCP_PATH}/`)) return res;
  const auth = req.headers.get("authorization");
  const empty = auth !== null && /^(bearer)?$/i.test(auth.trim());
  const body =
    auth === null || empty
      ? {
          error: auth === null ? "invalid_token" : "invalid_request",
          error_description: NO_TOKEN_HINT,
        }
      : {
          error: "invalid_request",
          error_description:
            "The Authorization header is malformed; send `Authorization: Bearer <token>`, or connect with OAuth instead.",
        };
  const headers = new Headers(res.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status: 401, headers });
}

/** Everything on the app host except PAT-authenticated /mcp. */
export async function serveAppHost(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  app: ProviderOptions["defaultHandler"],
): Promise<Response> {
  const limited = await registrationLimited(req, env);
  if (limited) return limited;
  if (isTokenRequest(req)) {
    const gated = await tokenGate(req, env);
    if (gated instanceof Response) return gated;
    req = gated;
  }
  const res = await oauthProvider(env, app).fetch(req, env, ctx);
  if (res.status === 401 && res.body === null) return explainNoToken(req, res);
  if (req.method === "POST" && new URL(req.url).pathname === OAUTH.register)
    await trackRegisteredClient(env, res);
  return res;
}

// ------------------------------------------------------------------ consent

const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'";

function html(body: string, status: number, headers?: Headers): Response {
  const h = new Headers(headers);
  h.set("content-type", "text/html; charset=utf-8");
  h.set("content-security-policy", PAGE_CSP);
  h.set("cache-control", "no-store");
  h.set("x-frame-options", "DENY");
  return new Response(body, { status, headers: h });
}

/** A small static page; `title` and `message` are escaped. */
function messagePage(title: string, message: string, status: number) {
  return html(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)} — Open Artifacts</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#15181c;background:#eef0f3}@media (prefers-color-scheme:dark){body{color:#e9ebee;background:#131518}}</style>
${FAVICON_TAGS}
</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`,
    status,
  );
}

const membersOnly = () =>
  messagePage(
    "Only members can connect agents",
    "Ask an admin of this workspace to make you a member, then try connecting again.",
    403,
  );

/** The signed-in browser user (session cookie only; Bearer tokens can't consent). */
const sessionUser = (c: Context<AppEnv>): Member | null =>
  c.var.tokenId ? null : c.var.user;

const csrfData = (uid: string, handle: string, exp: number) =>
  `oauth-consent:${uid}:${handle}:${exp}`;

/** `{exp}.{hmac}` bound to the session user and the consent handle (itself single-use). */
async function consentCsrf(env: Env, uid: string, handle: string) {
  const exp = Math.floor(Date.now() / 1000) + CSRF_TTL_S;
  return `${exp}.${await hmacSign(env.SESSION_SECRET, csrfData(uid, handle, exp))}`;
}

async function checkConsentCsrf(
  env: Env,
  uid: string,
  handle: string,
  token: string,
): Promise<boolean> {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp <= Math.floor(Date.now() / 1000)) return false;
  return hmacVerify(env.SESSION_SECRET, csrfData(uid, handle, exp), m[2] ?? "");
}

/** parseAuthRequest/approve/deny failures: redirect only when the library says it's safe. */
function authorizeError(e: unknown): Response {
  if (e instanceof AuthorizationError) {
    if (e.redirectTo)
      return new Response(null, {
        status: 302,
        headers: { location: e.redirectTo, "cache-control": "no-store" },
      });
    return messagePage(
      "Can't connect this agent",
      `${e.description || e.code}. Start connecting again from your agent.`,
      400,
    );
  }
  if (e instanceof CimdFetchError)
    return messagePage(
      "Can't connect this agent",
      "This app could not be verified.",
      400,
    );
  throw e;
}

async function showConsent(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url);
  const here = `${url.pathname}${url.search}`;
  const login = `${AUTH.login}?next=${encodeURIComponent(here)}`;
  const user = sessionUser(c);
  if (!user)
    return new Response(null, {
      status: 302,
      headers: { location: login, "cache-control": "no-store" },
    });
  if (!canConnect(user)) return membersOnly();
  // beginConsent writes KV: cap renders per user (RL_ANON, when bound).
  const rl = c.env.RL_ANON as RateLimit | undefined;
  if (rl && !(await rl.limit({ key: CONSENT_KEY + user.id })).success)
    return messagePage(
      "Too many requests",
      "Wait a minute, then start connecting again from your agent.",
      429,
    );
  const oauth = oauthApi(c.env);
  try {
    const request = await oauth.parseAuthRequest(c.req.raw);
    const details = await oauth.describeConsent(request);
    const consent = await oauth.beginConsent(request);
    const settings = await getSettings(c.env);
    const page = fillTemplate(CONSENT_TEMPLATE, {
      client_name: clientNameOf(details.clientName, details.clientId),
      redirect_host: details.redirectHost,
      user_email: user.email,
      instance_name: settings.name,
      instance_host: c.env.APP_HOST,
      form_action: OAUTH.authorize,
      csrf_token: await consentCsrf(c.env, user.id, consent.handle),
      request_id: consent.handle,
      switch_url: login,
    });
    return html(page, 200, consent.headers);
  } catch (e) {
    return authorizeError(e);
  }
}

async function decideConsent(c: Context<AppEnv>): Promise<Response> {
  // No sameOrigin(): the page's no-referrer policy makes browsers send
  // `Origin: null`. The signed token and the SameSite=Lax cookie cover CSRF.
  if (c.req.header("sec-fetch-site") === "cross-site")
    return messagePage("Can't connect this agent", "Cross-site request.", 403);
  const user = sessionUser(c);
  if (!user)
    return messagePage(
      "Signed out",
      "Your session ended. Start connecting again from your agent.",
      401,
    );
  const len = Number(c.req.header("content-length") ?? Number.NaN);
  if (!(len <= MAX_FORM_BYTES))
    return messagePage("Can't connect this agent", "Invalid form.", 400);
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    return messagePage("Can't connect this agent", "Invalid form.", 400);
  }
  const handle = String(form.get("request") ?? "");
  const csrf = String(form.get("csrf") ?? "");
  if (!handle || !(await checkConsentCsrf(c.env, user.id, handle, csrf)))
    return messagePage(
      "This page expired",
      "Start connecting again from your agent.",
      403,
    );
  if (!canConnect(user)) return membersOnly();
  const oauth = oauthApi(c.env);
  try {
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(c.req.raw, handle);
    const client = await oauth.lookupClient(approved.request.clientId);
    const props: GrantProps = {
      userId: user.id,
      clientName: clientNameOf(client?.clientName, approved.request.clientId),
      issuedAt: Date.now(),
    };
    // Still active right before the grant is written. A status change that
    // commits after this read is later than issuedAt, so the grant is
    // refused at use (apiHandler).
    if (!(await getUser(c.env, user.id)))
      return messagePage(
        "Signed out",
        "Your session ended. Start connecting again from your agent.",
        401,
      );
    // Only the redirect_uri of this request (validated against the client's
    // registered URIs), never client metadata such as client_uri; and only
    // coarse browser and OS families, no raw User-Agent or IP.
    const metadata: GrantMetadata = {
      clientName: props.clientName,
      ...redirectInfo(approved.request.redirectUri),
      approvedFrom: uaFamily(c.req.header("user-agent")),
    };
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: user.id,
      metadata,
      scope: approved.request.scope,
      props,
    });
    await markClientGranted(c.env, approved.request.clientId);
    approved.headers.set("location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (e) {
    return authorizeError(e);
  }
}

// ------------------------------------------------------------ oauth clients

const notFound = () => new ApiError("not_found", "Not found");

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The caller's grants (KV), each with its usage row (D1), newest first. With
 * `ctx`, and when the listing is complete (one page), usage rows of grants no
 * longer in KV are deleted in waitUntil (pruneGrantUsage, one statement).
 */
async function listClients(
  env: Env,
  user: Member,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<OAuthClient[]> {
  const { items, cursor } = await oauthApi(env).listUserGrants(user.id, {
    limit: MAX_GRANTS_LISTED,
  });
  const ids = items.map((g) => g.id);
  const usage = await grantUsage(env, user.id, ids);
  if (ctx && !cursor && items.length < MAX_GRANTS_LISTED)
    ctx.waitUntil(
      pruneGrantUsage(env, user.id, ids).catch((e) =>
        logError("grant_usage_prune_failed", e),
      ),
    );
  return items
    .map((g): OAuthClient => {
      const m = (g.metadata ?? {}) as GrantMetadata;
      const kind = RedirectKindSchema.safeParse(m.redirectKind);
      const from = ApprovedFromSchema.safeParse(m.approvedFrom);
      const u = usage.get(g.id);
      return {
        grantId: g.id,
        clientName: stripNameControls(clientNameOf(m.clientName, g.clientId)),
        createdAt: iso(g.createdAt * 1000),
        ...(u?.label ? { label: u.label } : {}),
        ...(kind.success ? { redirectKind: kind.data } : {}),
        ...(kind.data === "hosted" && typeof m.redirectHost === "string"
          ? { redirectHost: m.redirectHost }
          : {}),
        ...(from.success ? { approvedFrom: from.data } : {}),
        ...(u?.lastUsedAt != null ? { lastUsedAt: iso(u.lastUsedAt) } : {}),
        ...(clientVersionOf(u?.clientVersion)
          ? { clientVersion: clientVersionOf(u?.clientVersion) as string }
          : {}),
        ...(from.success
          ? { versionsPublished: u?.versionsPublished ?? 0 }
          : {}),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The caller's grant named by :grantId, or 404. */
async function ownGrant(
  c: Context<AppEnv>,
): Promise<{ user: Member; grant: OAuthClient }> {
  const user = requireUser(c);
  const grantId = c.req.param("grantId") ?? "";
  if (!GRANT_ID.test(grantId)) throw notFound();
  const grant = (await listClients(c.env, user)).find(
    (g) => g.grantId === grantId,
  );
  if (!grant) throw notFound();
  return { user, grant };
}

export function mountOAuth(app: AppType): void {
  app.get(OAUTH.authorize, showConsent);
  app.post(OAUTH.authorize, decideConsent);

  app.get(R.oauthClients, async (c) =>
    c.json(await listClients(c.env, requireUser(c), c.executionCtx)),
  );

  // Not for a capped caller (404): DELETE stays open so they can revoke.
  app.patch(`${R.oauthClients}/:grantId`, async (c) => {
    if (!canConnect(requireUser(c))) throw notFound();
    const { user, grant } = await ownGrant(c);
    const { label } = await jsonBody(c, OAuthClientPatchSchema);
    await setGrantLabel(c.env, grant.grantId, user.id, label);
    const { label: _old, ...rest } = grant;
    return c.json(label === null ? rest : { ...rest, label });
  });

  app.delete(`${R.oauthClients}/:grantId`, async (c) => {
    const { user, grant } = await ownGrant(c);
    await oauthApi(c.env).revokeGrant(grant.grantId, user.id);
    await dropGrantUsage(c.env, grant.grantId, user.id);
    return c.body(null, 204);
  });
}
