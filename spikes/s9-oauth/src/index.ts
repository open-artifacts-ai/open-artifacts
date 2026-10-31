// Spike S9 (design v7, 13.1; layout 9A.3.1): workers-oauth-provider 1.2.3's
// OAuthAuthorizationServer with the issuer on the api host and the
// authorization endpoint on the admin host. Throwaway: proves the library
// calls only. Sessions and the agent_tokens row are in-memory stand-ins; the
// consent page is JSON, not HTML. Never deployed.
import {
  AuthorizationError,
  OAuthAuthorizationServer,
  OAuthError,
} from "@cloudflare/workers-oauth-provider";

export type Env = { OAUTH_KV: KVNamespace; ADMIN_SESSION_KEY: string };

export const API = "https://api.provisioning.test";
export const ADMIN = "https://admin.provisioning.test";
export const RESOURCE = `${API}/mcp`;
export const SCOPES = [
  "installs:read",
  "installs:write",
  "installs:delete",
  "installs:pii",
  "audit:read",
] as const;
/** Access tokens: 15 min (9A.3). */
export const ACCESS_TTL_S = 900;
/** Refresh chain cap: 8 h, the admin cookie's lifetime (Q3). */
export const REFRESH_CAP_S = 28_800;
const SESSION_COOKIE = "__Host-oa-admin";

/** Stand-in for admin sessions (D1 in W13b): sid -> email and expiry (ms). */
export const sessions = new Map<string, { email: string; expiresAt: number }>();
/** Stand-in for agent_tokens.grant_id: tokenId -> grantId. */
export const grantIds = new Map<string, string>();

type Props = { tokenId: string; sessionHash: string };

/** Seconds of refresh chain left: the session's remaining life, capped at 8 h. */
export const refreshTtlFor = (sessionExpiresAt: number, now: number) =>
  Math.min(REFRESH_CAP_S, Math.floor((sessionExpiresAt - now) / 1000));

/** `adm_` + hex(HMAC-SHA256(key, "oauth-user\n" + email)) truncated to 16 bytes. */
export async function oauthUserId(key: string, email: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    k,
    new TextEncoder().encode(`oauth-user\n${email}`),
  );
  const hex = [...new Uint8Array(mac).slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `adm_${hex}`;
}

const liveSession = (sid: string) => {
  const s = sessions.get(sid);
  return s && s.expiresAt > Date.now() ? s : null;
};

export const authServer = new OAuthAuthorizationServer<Env>({
  issuer: API,
  authorizeEndpoint: `${ADMIN}/oauth/authorize`,
  tokenEndpoint: `${API}/oauth/token`,
  clientRegistrationEndpoint: `${API}/oauth/register`,
  resources: [RESOURCE],
  defaultResource: RESOURCE,
  accessTokenTTL: ACCESS_TTL_S,
  refreshTokenTTL: REFRESH_CAP_S,
  clientRegistrationTTL: 2_592_000,
  scopesSupported: [...SCOPES],
  disallowPublicClientRegistration: false,
  clientIdMetadataDocumentEnabled: false,
  tokenExchangeCallback: async (opts) => {
    const props = opts.props as Props;
    const session = liveSession(props.sessionHash);
    if (!session)
      throw new OAuthError("invalid_grant", {
        description: "The admin session ended",
      });
    if (opts.grantType !== "authorization_code") return;
    const ttl = refreshTtlFor(session.expiresAt, Date.now());
    if (ttl < 60)
      throw new OAuthError("invalid_grant", {
        description: "The admin session ends too soon",
      });
    grantIds.set(props.tokenId, opts.grantId);
    return { refreshTokenTTL: ttl };
  },
});

const json = (body: unknown, status = 200, headers?: Headers) => {
  const h = new Headers(headers);
  h.set("content-type", "application/json");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: h });
};

const sidOf = (req: Request) =>
  (req.headers.get("cookie") ?? "")
    .split(/;\s*/)
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1) ?? "";

async function authorizeGet(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (!liveSession(sidOf(req)))
    return new Response(null, {
      status: 302,
      headers: {
        location: `/auth/start?return=${encodeURIComponent(url.pathname + url.search)}`,
      },
    });
  const oauth = authServer.getOAuthApi(env);
  const request = await oauth.parseAuthRequest(req);
  const d = await oauth.describeConsent(request);
  const tx = await oauth.beginConsent(request);
  return json(
    {
      handle: tx.handle,
      clientName: d.clientName,
      redirectHost: d.redirectHost,
      redirectIsLoopback: d.redirectIsLoopback,
      scope: request.scope,
    },
    200,
    tx.headers,
  );
}

async function authorizePost(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("sec-fetch-site") === "cross-site")
    return json({ error: "cross_site" }, 403);
  const sid = sidOf(req);
  const session = liveSession(sid);
  if (!session) return json({ error: "signed_out" }, 401);
  const form = await req.formData();
  const handle = String(form.get("request") ?? "");
  const oauth = authServer.getOAuthApi(env);
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(req, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(req, handle, {
    scope: form.getAll("scope").map(String),
  });
  const tokenId = crypto.randomUUID();
  const props: Props = { tokenId, sessionHash: sid };
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: await oauthUserId(env.ADMIN_SESSION_KEY, session.email),
    metadata: {},
    scope: approved.request.scope,
    props,
  });
  approved.headers.set("location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

async function admin(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== "/oauth/authorize")
    return json({ error: "not_found" }, 404);
  try {
    if (req.method === "GET") return await authorizeGet(req, env);
    if (req.method === "POST") return await authorizePost(req, env);
    return json({ error: "method_not_allowed" }, 405);
  } catch (e) {
    if (e instanceof AuthorizationError)
      return json({ error: e.code, error_description: e.message }, 400);
    throw e;
  }
}

async function api(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
    return json({
      resource: RESOURCE,
      authorization_servers: [API],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ["header"],
    });
  if (url.pathname === "/mcp") {
    const bearer = req.headers
      .get("authorization")
      ?.match(/^Bearer (.+)$/)?.[1];
    const v = bearer
      ? await authServer.validateToken<Props>(RESOURCE, bearer, env)
      : null;
    return v
      ? json({ ok: true, scope: v.scope })
      : json({ error: "unauthenticated" }, 401);
  }
  return authServer.fetch(req, env, ctx);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const { origin } = new URL(req.url);
    if (origin === ADMIN) return admin(req, env);
    if (origin === API) return api(req, env, ctx);
    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
