import type { Env } from "../../env.js";
import { NotImplemented, notImplemented } from "../../errors.js";
import type { RevokedGrant } from "../../services/tokens.js";

// The MCP OAuth authorization server (design v7 9A.3.1), W13b: the AS on the
// api host (/oauth/token, /oauth/register, RFC 8414 metadata), our RFC 9728
// handler, and the consent page on the admin host (/oauth/authorize). Which
// method and host serve each path is PROTOCOL_ROUTES (@oa/shared/provisioning).

/** Under these prefixes only PROTOCOL_ROUTES exist; anything else is 404. */
export const isOAuthPath = (path: string) =>
  path.startsWith("/oauth/") || path.startsWith("/.well-known/oauth-");

export async function handleOAuth(
  _req: Request,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  return notImplemented();
}

/**
 * Ends each grant in the library's store (OAUTH_KV), after the token service
 * revoked its D1 row: R21 (one or all) and a superseding consent (3.4 R21,
 * 4.6). W13b builds it on the provider's `revokeGrant(grantId, userId)`.
 * Callers run it off the response path: D1 already refuses the token.
 */
export async function revokeOAuthGrants(
  _env: Env,
  grants: readonly RevokedGrant[],
): Promise<void> {
  if (grants.length > 0) throw new NotImplemented("revokeOAuthGrants");
}
