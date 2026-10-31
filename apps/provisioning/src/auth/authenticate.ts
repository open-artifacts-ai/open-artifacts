import type { Env } from "../env.js";
import type { HostKind } from "../hosts.js";
import { type Principal, type Refusal, refusal } from "../principal.js";
import { sessionPrincipal } from "./session.js";

/**
 * The authn step (design v7 4.2): on admin the `__Host-oa-admin` session
 * (W5a); on api `Bearer oat_` and, for `/mcp`, an OAuth access token, both
 * through tokenPrincipal, plus GitHub OIDC on staging (W5b). Host policy has
 * already refused the wrong credential type for the host; api.<app> never
 * reads the cookie. The api path fails closed until W5b.
 */
export async function authenticate(
  req: Request,
  env: Env,
  host: HostKind,
  now: number = Date.now(),
): Promise<Principal | Refusal> {
  if (host === "admin") return sessionPrincipal(req, env, now);
  return refusal("unauthenticated");
}
