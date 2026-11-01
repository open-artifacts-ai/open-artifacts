import { API_ERROR_STATUS } from "@oa/shared/provisioning";
import { authenticate } from "../auth/authenticate.js";
import type { Env } from "../env.js";
import type { Principal, Refusal } from "../principal.js";

// The authn step of POST /mcp (design v7 9A.3.3). `Bearer oat_` and, on
// staging, a GitHub OIDC JWT take the existing authenticate() path (W5b's
// tokenPrincipal: a D1 read per call). Any other bearer is an OAuth access
// token: `oauthPrincipal` validates it (W13b: as.validateToken, then
// principalByTokenId(..., "oauth")). Cookies are never read. Only a token or
// an OIDC principal passes: a self-serve user is 401 here (4.2).

/** W13b's seam: the principal for an OAuth access token, or a refusal. */
export type OAuthPrincipal = (
  req: Request,
  env: Env,
  token: string,
) => Promise<Principal | Refusal>;

/** Until W13b wires the AS, every OAuth bearer is 401. */
const noOAuth: OAuthPrincipal = async () => ({
  refusal: true,
  code: "unauthenticated",
});

const BEARER_RE = /^Bearer (\S+)$/i;

export async function mcpPrincipal(
  req: Request,
  env: Env,
  oauthPrincipal: OAuthPrincipal = noOAuth,
): Promise<Principal | null> {
  const token = BEARER_RE.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!token) return null;
  const opaque = !token.startsWith("oat_") && token.split(".").length !== 3;
  const p = opaque
    ? await oauthPrincipal(req, env, token)
    : await authenticate(req, env, "api");
  if ("refusal" in p) return null;
  return p.kind === "token" || p.kind === "oidc" ? p : null;
}

/** RFC 9728 metadata for https://api.<app>/mcp (W13b serves the document). */
export const resourceMetadataUrl = (env: Pick<Env, "APP_DOMAIN">) =>
  `https://api.${env.APP_DOMAIN}/.well-known/oauth-protected-resource/mcp`;

/**
 * A bad or missing bearer before dispatch (9A.6): HTTP 401, the API
 * envelope, and the challenge that starts the client's OAuth flow.
 */
export const mcpUnauthorized = (env: Pick<Env, "APP_DOMAIN">) =>
  new Response(
    JSON.stringify({
      error: { code: "unauthenticated", message: "unauthenticated" },
    }),
    {
      status: API_ERROR_STATUS.unauthenticated,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "www-authenticate": `Bearer realm="OAuth", error="invalid_token", resource_metadata="${resourceMetadataUrl(env)}"`,
      },
    },
  );
