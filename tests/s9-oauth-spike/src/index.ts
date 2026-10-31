// Spike S9 (design v7, 13.1; layout 9A.3.1): workers-oauth-provider 1.2.3's
// OAuthAuthorizationServer with the issuer on the api host and the
// authorization endpoint on the admin host. Throwaway: proves the library
// calls only. Sessions and the agent_tokens row are in-memory stand-ins; the
// consent page is JSON, not HTML. Not covered (W13b): the Sec-Fetch-Site
// bounce (9A.3.2 step 3), tokenPrincipal's D1 and ADMIN_IDENTITIES re-check
// (9A.3.3 step 2), audit rows. Never deployed.
import {
  AuthorizationError,
  OAuthAuthorizationServer,
  type OAuthAuthorizationServerOptions,
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
/** Consent needs this much session left (9A.3.2 step 4). */
export const CONSENT_MIN_SESSION_MS = 3_600_000;
/** The library's KV floor (KV_MIN_EXPIRATION_TTL_SECONDS): a shorter refresh TTL cannot be stored. */
export const MIN_REFRESH_TTL_S = 60;
/** Exact redirect allowlist beside loopback (MCP_REDIRECT_URIS in W13b). */
export const REDIRECT_ALLOWLIST = ["https://claude.ai/api/mcp/auth_callback"];

/** Stand-in for admin sessions (D1 in W13b): sessionHash -> email and expiry (ms). */
export const sessions = new Map<string, { email: string; expiresAt: number }>();
/** Stand-in for agent_tokens.grant_id: tokenId -> grantId. */
export const grantIds = new Map<string, string>();

type Props = { tokenId: string; sessionHash: string };

/** Seconds of refresh chain left: the session's remaining life, capped at 8 h. */
export const refreshTtlFor = (sessionExpiresAt: number, now: number) =>
  Math.min(REFRESH_CAP_S, Math.floor((sessionExpiresAt - now) / 1000));

const hex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

const hmacKey = (key: string, use: "sign" | "verify") =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [use],
  );

const hmac = async (key: string, msg: string) =>
  crypto.subtle.sign(
    "HMAC",
    await hmacKey(key, "sign"),
    new TextEncoder().encode(msg),
  );

/** `adm_` + hex(HMAC-SHA256(key, "oauth-user\n" + email)) truncated to 16 bytes. */
export async function oauthUserId(key: string, email: string): Promise<string> {
  const mac = await hmac(key, `oauth-user\n${email}`);
  return `adm_${hex(new Uint8Array(mac).slice(0, 16))}`;
}

/** hex(SHA-256(sid)): what props and agent_tokens.session_hash hold, never the raw sid. */
export const sessionHashOf = async (sid: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sid)));

/** HMAC-SHA256(key, "consent\n" + sid + "\n" + handle) (9A.3.2 step 6). Valid as long as the handle (10 min). */
export const consentToken = async (key: string, sid: string, handle: string) =>
  hex(await hmac(key, `consent\n${sid}\n${handle}`));

/** Constant-time check of a consent token (HMAC verify, not string compare). */
async function consentTokenOk(
  key: string,
  sid: string,
  handle: string,
  token: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(token)) return false;
  const mac = new Uint8Array(
    token.match(/../g)?.map((h) => Number.parseInt(h, 16)) ?? [],
  );
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(key, "verify"),
    mac,
    new TextEncoder().encode(`consent\n${sid}\n${handle}`),
  );
}

const liveByHash = (sessionHash: string) => {
  const s = sessions.get(sessionHash);
  return s && s.expiresAt > Date.now() ? s : null;
};

const liveSession = async (sid: string) =>
  sid ? liveByHash(await sessionHashOf(sid)) : null;

const isLoopback = (u: URL) =>
  u.protocol === "http:" &&
  ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
  u.port !== "";

const allowedRedirect = (raw: unknown) => {
  if (typeof raw !== "string" || !URL.canParse(raw)) return false;
  const u = new URL(raw);
  return isLoopback(u) || REDIRECT_ALLOWLIST.includes(u.href);
};

/** refreshTokenIdleTTL stays unset: with it, each refresh moves grant.expiresAt and the chain could outlive the session (Q3). */
export const authOptions: OAuthAuthorizationServerOptions<Env> = {
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
  clientRegistrationCallback: ({ clientMetadata }) => {
    const uris = clientMetadata.redirect_uris;
    if (
      !Array.isArray(uris) ||
      uris.length === 0 ||
      !uris.every(allowedRedirect)
    )
      return {
        code: "invalid_redirect_uri",
        description: "Redirect URIs must be loopback or on the allowlist",
      };
  },
  // On a throw of invalid_grant the library revokes the grant itself
  // (1.2.3, oauth-provider.js:3414-3429), so no explicit revokeGrant here.
  tokenExchangeCallback: async (opts) => {
    if (
      opts.grantType !== "authorization_code" &&
      opts.grantType !== "refresh_token"
    )
      throw new OAuthError("invalid_grant", {
        description: "Unsupported grant type",
      });
    const props = opts.props as Props;
    // Stand-in for tokenPrincipal(row, session) (9A.3.3 step 2).
    const session = liveByHash(props.sessionHash);
    if (!session)
      throw new OAuthError("invalid_grant", {
        description: "The admin session ended",
      });
    if (opts.grantType === "refresh_token") return;
    const ttl = refreshTtlFor(session.expiresAt, Date.now());
    if (ttl < MIN_REFRESH_TTL_S)
      throw new OAuthError("invalid_grant", {
        description: "The admin session ends too soon",
      });
    grantIds.set(props.tokenId, opts.grantId);
    return { refreshTokenTTL: ttl };
  },
};

export const authServer = new OAuthAuthorizationServer<Env>(authOptions);

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
  const sid = sidOf(req);
  const session = await liveSession(sid);
  if (!session || session.expiresAt - Date.now() < CONSENT_MIN_SESSION_MS)
    return new Response(null, {
      status: 302,
      headers: {
        location: `/auth/start?return=${encodeURIComponent(url.pathname + url.search)}`,
      },
    });
  const oauth = authServer.getOAuthApi(env);
  const request = await oauth.parseAuthRequest(req);
  // The library requires PKCE only for public clients (9A.3.1).
  if (!request.codeChallenge || request.codeChallengeMethod !== "S256")
    return json(
      { error: "invalid_request", error_description: "PKCE S256 is required" },
      400,
    );
  const d = await oauth.describeConsent(request);
  const tx = await oauth.beginConsent(request);
  // tx.headers carry the library's __Host-oauth-* binding cookie, which the
  // POST must send back: merge them, never replace them.
  return json(
    {
      handle: tx.handle,
      consentToken: await consentToken(env.ADMIN_SESSION_KEY, sid, tx.handle),
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
  const session = await liveSession(sid);
  if (!session) return json({ error: "signed_out" }, 401);
  const form = await req.formData();
  const handle = String(form.get("request") ?? "");
  const consent = String(form.get("consent") ?? "");
  if (!(await consentTokenOk(env.ADMIN_SESSION_KEY, sid, handle, consent)))
    return json({ error: "bad_consent_token" }, 403);
  const oauth = authServer.getOAuthApi(env);
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(req, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const scope = form.getAll("scope").map(String);
  // The library accepts [] ([].every is true): a grant with no scopes.
  if (scope.length === 0)
    return json(
      { error: "invalid_scope", error_description: "Pick at least one scope" },
      400,
    );
  const approved = await oauth.approveConsent(req, handle, { scope });
  const tokenId = crypto.randomUUID();
  const props: Props = { tokenId, sessionHash: await sessionHashOf(sid) };
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
    // Not covered: tokenPrincipal's D1 and session re-check (9A.3.3 step 2),
    // so an access token here outlives logout by up to 15 min.
    if (v) return json({ ok: true, scope: v.scope });
    const h = new Headers({
      "www-authenticate": `Bearer realm="OAuth", error="invalid_token", resource_metadata="${API}/.well-known/oauth-protected-resource/mcp"`,
    });
    return json(
      {
        error: {
          code: "unauthenticated",
          message: "A valid bearer token is required",
        },
      },
      401,
      h,
    );
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
