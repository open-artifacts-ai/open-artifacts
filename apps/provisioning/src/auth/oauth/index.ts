import type { Env } from "../../env.js";
import { errorResponse } from "../../errors.js";
import { protectedResource } from "./bearer.js";
import { decideConsent, showConsent } from "./consent.js";
import { registerEndpoint, tokenEndpoint } from "./endpoints.js";
import { authServer } from "./server.js";

// The MCP OAuth authorization server (design v7 9A.3.1), W13b: the AS on the
// api host (/oauth/token, /oauth/register, RFC 8414 metadata), our RFC 9728
// handler, and the consent page on the admin host (/oauth/authorize). Which
// method and host serve each path is PROTOCOL_ROUTES (@oa/shared/provisioning);
// the adapter has checked both before this runs.

export { mcpUnauthorized, oauthPrincipal } from "./bearer.js";
export {
  authServer,
  mcpResource,
  refreshTtlFor,
  revokeLibraryGrants,
} from "./server.js";

/** Under these prefixes only PROTOCOL_ROUTES exist; anything else is 404. */
export const isOAuthPath = (path: string) =>
  path.startsWith("/oauth/") || path.startsWith("/.well-known/oauth-");

export async function handleOAuth(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  switch (new URL(req.url).pathname) {
    case "/oauth/authorize":
      return req.method === "GET"
        ? showConsent(req, env)
        : decideConsent(req, env);
    case "/oauth/token":
      return tokenEndpoint(req, env, ctx);
    case "/oauth/register":
      return registerEndpoint(req, env, ctx);
    case "/.well-known/oauth-authorization-server":
      return authServer(env).fetch(req, env, ctx);
    case "/.well-known/oauth-protected-resource/mcp":
      return protectedResource(env);
    default:
      return errorResponse("not_found");
  }
}
