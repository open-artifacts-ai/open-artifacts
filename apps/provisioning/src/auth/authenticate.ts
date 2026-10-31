import type { Env } from "../env.js";
import type { HostKind } from "../hosts.js";
import { type Principal, type Refusal, refusal } from "../principal.js";
import { principalByBearer } from "../services/tokens.js";
import { oidcPrincipal } from "./oidc.js";

/** Three base64url parts: a JWT (the OIDC bearer); OAuth tokens are not. */
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * The authn step (design v7 4.2): on admin the `__Host-oa-admin` session
 * (W5a); on api `Bearer oat_` through tokenPrincipal (a D1 read per call),
 * plus GitHub OIDC on staging. An OAuth access token is `/mcp` only: the MCP
 * adapter validates it (W13b) and checks it with principalByTokenId(...,
 * "oauth"); here it is 401, so `/v1` refuses it. Host policy has already
 * refused the wrong credential type for the host.
 */
export async function authenticate(
  req: Request,
  env: Env,
  host: HostKind,
): Promise<Principal | Refusal> {
  if (host !== "api") return refusal("unauthenticated");
  const m = /^Bearer (\S+)$/i.exec(req.headers.get("authorization") ?? "");
  const token = m?.[1];
  if (!token) return refusal("unauthenticated");
  if (token.startsWith("oat_")) return principalByBearer(env, token);
  if (JWT_RE.test(token)) return oidcPrincipal(req, env, token);
  return refusal("unauthenticated");
}
