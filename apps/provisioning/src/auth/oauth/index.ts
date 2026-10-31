import type { Env } from "../../env.js";
import { notImplemented } from "../../errors.js";

// The MCP OAuth authorization server (design v7 9A.3.1), W13b: the AS on the
// api host (/oauth/token, /oauth/register, RFC 8414 metadata), our RFC 9728
// handler, and the consent page on the admin host (/oauth/authorize).

/** The OAuth paths each host serves; any other host is 404 for them. */
export const OAUTH_PATHS = {
  api: [
    "/oauth/token",
    "/oauth/register",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource/mcp",
  ],
  admin: ["/oauth/authorize"],
} as const;

export const isOAuthPath = (path: string) =>
  path.startsWith("/oauth/") || path.startsWith("/.well-known/oauth-");

export async function handleOAuth(
  _req: Request,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  return notImplemented();
}
