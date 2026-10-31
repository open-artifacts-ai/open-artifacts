import type { Env } from "../../env.js";
import { notImplemented } from "../../errors.js";

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
