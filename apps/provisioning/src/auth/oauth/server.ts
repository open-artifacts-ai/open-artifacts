import {
  OAuthAuthorizationServer,
  OAuthError,
  type TokenExchangeCallbackOptions,
  type TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { TokenScopeSchema } from "@oa/shared/provisioning";
import type { Env } from "../../env.js";
import { limit } from "../../limits.js";
import { isRefusal } from "../../principal.js";
import {
  type AgentTokenRow,
  getToken,
  OAUTH_ACCESS_TTL_S,
  OAUTH_GRANT_MAX_MS,
  type RevokedGrant,
  type SessionRow,
  type TokenRefusalReason,
  tokenPrincipal,
} from "../../services/tokens.js";
import { oauthAudit } from "./audit.js";

// The MCP OAuth authorization server (design v7 9A.3.1): workers-oauth-
// provider 1.2.3's OAuthAuthorizationServer with the issuer on the api host
// and the authorization endpoint on the admin host (spike S9). The library
// keeps clients, grants and tokens in OAUTH_KV; D1's agent_tokens row is what
// every call and refresh checks (tokenPrincipal), so KV lag never extends a
// grant.

/** The five TokenScope values, in the enum's order. */
export const OAUTH_SCOPES = [...TokenScopeSchema.options];
/** The refresh chain's cap: the admin cookie's 8 h (Q3). */
export const REFRESH_CAP_S = OAUTH_GRANT_MAX_MS / 1000;
/** 30 days (the library's default is 90): a secret grants nothing without a live grant. */
export const CLIENT_REGISTRATION_TTL_S = 2_592_000;
/** The library's KV floor: a shorter refresh TTL cannot be stored. */
export const MIN_REFRESH_TTL_S = 60;

/** What the library keeps encrypted on the grant; never an email. */
export type GrantProps = { tokenId: string; sessionHash: string };

export const apiOrigin = (env: Pick<Env, "APP_DOMAIN">) =>
  `https://api.${env.APP_DOMAIN}`;
export const mcpResource = (env: Pick<Env, "APP_DOMAIN">) =>
  `${apiOrigin(env)}/mcp`;
export const resourceMetadataUrl = (env: Pick<Env, "APP_DOMAIN">) =>
  `${apiOrigin(env)}/.well-known/oauth-protected-resource/mcp`;

/** Seconds of refresh chain left: the time to `endsAt`, capped at 8 h (Q3). */
export const refreshTtlFor = (endsAt: number, now: number) =>
  Math.min(REFRESH_CAP_S, Math.floor((endsAt - now) / 1000));

/** `http://127.0.0.1:<port>`, `http://localhost:<port>`, `http://[::1]:<port>`. */
export const isLoopbackRedirect = (u: URL) =>
  u.protocol === "http:" &&
  ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
  u.port !== "";

/** MCP_REDIRECT_URIS (comma list), each normalized by URL parsing. */
export const redirectAllowlist = (raw: string | undefined) =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => URL.canParse(s))
    .map((s) => new URL(s).href);

/**
 * A DCR redirect URI is loopback with an explicit port, or exactly equal,
 * after URL parsing, to an allowlist entry. A host match is not enough:
 * claude.ai has many tenants and hosts user content (9A.3.1).
 */
export function allowedRedirect(raw: unknown, allow: readonly string[]) {
  if (typeof raw !== "string" || !URL.canParse(raw)) return false;
  const u = new URL(raw);
  return isLoopbackRedirect(u) || allow.includes(u.href);
}

/** oauth_clients.redirect_hosts: loopback as "loopback" (8.3). */
export const redirectHosts = (uris: readonly string[]) => [
  ...new Set(
    uris.map((s) => {
      const u = new URL(s);
      return isLoopbackRedirect(u) ? "loopback" : u.hostname;
    }),
  ),
];

const invalidGrant = (description: string) =>
  new OAuthError("invalid_grant", { description });

/** The row and its session, read from D1 on every exchange and refresh. */
async function rowAndSession(
  env: Env,
  tokenId: string,
): Promise<{ row: AgentTokenRow | null; session: SessionRow | null }> {
  const row = await getToken(env, tokenId);
  if (!row) return { row: null, session: null };
  const session = await env.PLATFORM_DB.prepare(
    "SELECT * FROM sessions WHERE id_hash = ?1",
  )
    .bind(row.session_hash)
    .first<SessionRow>();
  return { row, session };
}

/** 9A.8 `oauth.refresh_refused` reasons. */
type RefreshRefusal =
  | "session_ended"
  | "identity_removed"
  | "revoked"
  | "chain_ended";
const refusalReason = (r: TokenRefusalReason): RefreshRefusal =>
  r === "session_ended" || r === "identity_removed"
    ? r
    : r === "expired"
      ? "chain_ended"
      : "revoked";

/**
 * Code exchange: the row must be a live `oauth` row of a live session; its
 * grant_id is recorded here (completeAuthorization returns only the
 * redirect), and the chain's refresh TTL is the row's end (the session's,
 * at most 8 h). Refresh: tokenPrincipal must pass for the row the grant
 * names; else the grant is revoked in KV, audited and refused.
 */
async function onTokenExchange(
  opts: TokenExchangeCallbackOptions<Env>,
): Promise<TokenExchangeCallbackResult | undefined> {
  const env = opts.env;
  // Charged after client auth, so a forged client_id drains nothing (9A.7).
  const rl = await limit(env, "oauth_ip", `tok:${opts.clientId}`);
  if (rl)
    throw new OAuthError("temporarily_unavailable", {
      description: "Too many token requests; try again in a minute",
      statusCode: rl.code === "rate_limited" ? 429 : 503,
      headers: { "retry-after": "60", "cache-control": "no-store" },
    });
  if (
    opts.grantType !== "authorization_code" &&
    opts.grantType !== "refresh_token"
  )
    throw invalidGrant("Unsupported grant type");
  const props = opts.props as Partial<GrantProps> | null;
  const tokenId = typeof props?.tokenId === "string" ? props.tokenId : "";
  const { row, session } = tokenId
    ? await rowAndSession(env, tokenId)
    : { row: null, session: null };
  const now = Date.now();

  if (opts.grantType === "authorization_code") {
    if (!row || row.kind !== "oauth" || row.grant_id !== null)
      throw invalidGrant("The grant was revoked");
    const p = tokenPrincipal(row, session, env, "oauth");
    if (isRefusal(p))
      throw invalidGrant("The grant was revoked or the admin session ended");
    const ttl = refreshTtlFor(row.expires_at, now);
    if (ttl < MIN_REFRESH_TTL_S)
      throw invalidGrant("The admin session ends too soon");
    const set = await env.PLATFORM_DB.prepare(
      "UPDATE agent_tokens SET grant_id = ?2 WHERE id = ?1 AND kind = 'oauth' AND revoked_at IS NULL AND grant_id IS NULL",
    )
      .bind(row.id, opts.grantId)
      .run();
    if ((set.meta.changes ?? 0) === 0)
      throw invalidGrant("The grant was revoked");
    return {
      refreshTokenTTL: ttl,
      accessTokenTTL: Math.min(OAUTH_ACCESS_TTL_S, ttl),
    };
  }

  // refresh_token: nothing returned keeps the grant's end (the chain never
  // outlives the session; refreshTokenIdleTTL stays unset).
  let reason: RefreshRefusal | null = null;
  if (!row || row.grant_id !== opts.grantId) reason = "revoked";
  else {
    const p = tokenPrincipal(row, session, env, "oauth");
    if (isRefusal(p)) reason = refusalReason(p.reason);
  }
  if (reason === null) return undefined;
  await revokeLibraryGrants(env, [
    { grantId: opts.grantId, oauthUser: opts.userId },
  ]);
  if (row)
    await oauthAudit(env, {
      action: "oauth.refresh_refused",
      actor: { kind: "token", label: row.label },
      tokenId: row.id,
      outcome: "refused",
      code: "invalid_grant",
      detail: { tokenId: row.id, admin: row.admin_email, reason },
    }).catch(() => {});
  throw invalidGrant("The grant ended; approve the agent again");
}

const servers = new Map<string, OAuthAuthorizationServer<Env>>();

/**
 * The AS for this env's hosts and redirect allowlist. Options are fixed per
 * construction (the registration callback gets no env), so one per
 * (APP_DOMAIN, MCP_REDIRECT_URIS).
 */
export function authServer(
  env: Pick<Env, "APP_DOMAIN" | "MCP_REDIRECT_URIS">,
): OAuthAuthorizationServer<Env> {
  const key = `${env.APP_DOMAIN}\n${env.MCP_REDIRECT_URIS}`;
  let s = servers.get(key);
  if (s) return s;
  const api = apiOrigin(env);
  const allow = redirectAllowlist(env.MCP_REDIRECT_URIS);
  s = new OAuthAuthorizationServer<Env>({
    issuer: api,
    authorizeEndpoint: `https://admin.${env.APP_DOMAIN}/oauth/authorize`,
    tokenEndpoint: `${api}/oauth/token`,
    clientRegistrationEndpoint: `${api}/oauth/register`,
    resources: [mcpResource(env)],
    defaultResource: mcpResource(env),
    accessTokenTTL: OAUTH_ACCESS_TTL_S,
    refreshTokenTTL: REFRESH_CAP_S,
    clientRegistrationTTL: CLIENT_REGISTRATION_TTL_S,
    scopesSupported: OAUTH_SCOPES,
    disallowPublicClientRegistration: false,
    clientIdMetadataDocumentEnabled: false,
    clientRegistrationCallback: ({ clientMetadata }) => {
      const uris = clientMetadata.redirect_uris;
      if (
        !Array.isArray(uris) ||
        uris.length === 0 ||
        !uris.every((u) => allowedRedirect(u, allow))
      )
        return {
          code: "invalid_redirect_uri",
          description:
            "Redirect URIs must be loopback with a port or an exact allowed URI",
        };
    },
    tokenExchangeCallback: onTokenExchange,
  });
  servers.set(key, s);
  return s;
}

/**
 * Ends grants in the library's store: R21, R24, a superseding consent and a
 * refused refresh. D1 has already refused them (the per-call check), so a
 * failed KV revoke never changes an answer.
 */
export async function revokeLibraryGrants(
  env: Env,
  grants: readonly RevokedGrant[],
): Promise<void> {
  const oauth = authServer(env).getOAuthApi(env);
  for (const g of grants) {
    try {
      await oauth.revokeGrant(g.grantId, g.oauthUser);
    } catch {
      // D1 is authoritative; the grant also dies with its KV TTL.
    }
  }
}
