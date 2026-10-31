import type { Env } from "../../env.js";
import { errorResponse } from "../../errors.js";
import { type Principal, type Refusal, refusal } from "../../principal.js";
import { getToken, type SessionRow, tokenPrincipal } from "../../services/tokens.js";
import {
  authServer,
  type GrantProps,
  mcpResource,
  OAUTH_SCOPES,
  resourceMetadataUrl,
} from "./server.js";

// The resource side of /mcp for OAuth bearers (design v7 9A.3.3): the
// library validates the token for the mcp resource, then tokenPrincipal
// checks the row it names in D1 on every call, so logout, revoke, session
// end and identity removal take effect at once whatever KV still holds.
// W13a's adapter calls oauthPrincipal for a non-`oat_` bearer and answers
// a refusal with mcpUnauthorized.

/** The principal for an OAuth access token at /mcp, or 401. */
export async function oauthPrincipal(
  env: Env,
  bearer: string,
): Promise<Principal | Refusal> {
  const no = refusal("unauthenticated");
  let v: { props: Partial<GrantProps> | null } | null;
  try {
    v = await authServer(env).validateToken<Partial<GrantProps> | null>(
      mcpResource(env),
      bearer,
      env,
    );
  } catch {
    return no;
  }
  const tokenId = v?.props?.tokenId;
  if (typeof tokenId !== "string") return no;
  const row = await getToken(env, tokenId);
  // The token names its grant (`{userId}:{grantId}:{secret}`); the row must
  // be that grant's, recorded at code exchange.
  if (!row || row.grant_id === null || row.grant_id !== bearer.split(":")[1])
    return no;
  const session = await env.PLATFORM_DB.prepare(
    "SELECT * FROM sessions WHERE id_hash = ?1",
  )
    .bind(row.session_hash)
    .first<SessionRow>();
  const p = tokenPrincipal(row, session, env, "oauth");
  return "refusal" in p ? no : p;
}

/** RFC 9728 for /mcp (9A.3.1), ours: the library's options have no resourceMetadata. */
export const protectedResource = (env: Env) =>
  new Response(
    JSON.stringify({
      resource: mcpResource(env),
      authorization_servers: [`https://api.${env.APP_DOMAIN}`],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ["header"],
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    },
  );

/** The /mcp 401 (9A.3.2 step 1): the API envelope plus the discovery challenge. */
export const mcpUnauthorized = (env: Env) =>
  errorResponse("unauthenticated", "unauthenticated", undefined, {
    "www-authenticate": `Bearer realm="OAuth", error="invalid_token", resource_metadata="${resourceMetadataUrl(env)}"`,
  });
