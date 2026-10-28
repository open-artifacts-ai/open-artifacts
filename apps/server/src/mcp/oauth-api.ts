import {
  type GrantSummary,
  getOAuthApi,
  OAuthError,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { MCP_PATH } from "@oa/shared";
import type { Env } from "../env.js";
import { logWarn } from "../log.js";
import { mcpResource } from "./server.js";

// The provider's configuration and its helpers, without the MCP handler, so
// services (member changes) can revoke grants without importing the server.

export const OAUTH = {
  authorize: "/oauth/authorize",
  token: "/oauth/token",
  register: "/oauth/register",
} as const;

/** Token grants (refresh storms: 2 KV writes each) per client per RL_ANON window. */
const TOKEN_KEY = "tok:";

/** OAuth access-token lifetime (24 h; the provider default is 1 h). */
export const ACCESS_TOKEN_TTL_S = 86_400;

export type ProviderOptions = OAuthProviderOptions<Env>;
type Handler = ProviderOptions["defaultHandler"];

export function providerOptions(
  env: Env,
  apiHandler: NonNullable<ProviderOptions["apiHandler"]>,
  defaultHandler: Handler,
): ProviderOptions {
  const resource = mcpResource(env);
  return {
    apiRoute: MCP_PATH,
    apiHandler,
    defaultHandler,
    authorizeEndpoint: OAUTH.authorize,
    tokenEndpoint: OAUTH.token,
    clientRegistrationEndpoint: OAUTH.register,
    // Each refresh costs 2 KV writes (Free plan: 1000/day): long-lived access
    // tokens keep agents from refreshing hourly.
    accessTokenTTL: ACCESS_TOKEN_TTL_S,
    // The provider calls this only once the client and its code or refresh
    // token are verified, and before it writes KV, so `tok:<client_id>` is
    // charged to the authenticated client: a forged client_id cannot drain it.
    tokenExchangeCallback: async ({ clientId, env }) => {
      const rl = env.RL_ANON as RateLimit | undefined;
      if (!rl || (await rl.limit({ key: TOKEN_KEY + clientId })).success)
        return;
      throw new OAuthError("temporarily_unavailable", {
        description: "Too many token requests; try again in a minute",
        statusCode: 429,
        headers: { "retry-after": "60", "cache-control": "no-store" },
      });
    },
    // #769: a refresh with a token that is neither the grant's current nor
    // its previous one (refresh_token_mismatch: a client replaying an old
    // token, or two refreshing at once). The event only: never the token,
    // the client secret or who it was.
    onError: ({ internal }) => {
      if (internal?.reason === "refresh_token_mismatch")
        logWarn("oauth_refresh_mismatch");
    },
    resourceMetadata: {
      resource,
      authorization_servers: [new URL(resource).origin],
      bearer_methods_supported: ["header"],
      resource_name: "Open Artifacts",
    },
  };
}

const NO_HANDLER = { fetch: () => new Response(null, { status: 404 }) };

/** OAuth helpers (parse/consent/complete, grants) outside the provider's fetch. */
export const oauthApi = (env: Env): OAuthHelpers =>
  getOAuthApi(providerOptions(env, NO_HANDLER, NO_HANDLER), env);

/** Upper bound on grant pages walked per revocation (100 grants per page). */
const MAX_GRANT_PAGES = 10;

/**
 * Every grant the user holds, page by page (100 per page, at most
 * MAX_GRANT_PAGES). `complete` is false when pages were left unread, so a
 * caller never prunes against a partial list (review item 40).
 */
export async function listAllUserGrants(
  env: Env,
  userId: string,
): Promise<{ items: GrantSummary[]; complete: boolean }> {
  const oauth = oauthApi(env);
  const items: GrantSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_GRANT_PAGES; page++) {
    const r = await oauth.listUserGrants(userId, { limit: 100, cursor });
    items.push(...r.items);
    cursor = r.cursor;
    if (!cursor) return { items, complete: true };
  }
  return { items, complete: false };
}

/**
 * One of the user's grants by id: a direct read of the provider's grant
 * record (`grant:<userId>:<grantId>`, the key listUserGrants lists), so no
 * listing page or KV list lag decides whether it exists. Null when absent
 * or not this user's. The caller checked grantId's shape (no ':').
 */
export async function lookupUserGrant(
  env: Env,
  userId: string,
  grantId: string,
): Promise<GrantSummary | null> {
  const g = await env.OAUTH_KV.get<GrantSummary>(
    `grant:${userId}:${grantId}`,
    "json",
  );
  return g && g.id === grantId && g.userId === userId ? g : null;
}

/**
 * Revokes every OAuth grant (and its tokens) the user holds. Re-lists from the
 * start each round, since revoked grants drop out of the listing.
 */
export async function revokeAllGrants(env: Env, userId: string): Promise<void> {
  const oauth = oauthApi(env);
  for (let page = 0; page < MAX_GRANT_PAGES; page++) {
    const { items } = await oauth.listUserGrants(userId, { limit: 100 });
    if (items.length === 0) return;
    await Promise.all(items.map((g) => oauth.revokeGrant(g.id, userId)));
  }
}
