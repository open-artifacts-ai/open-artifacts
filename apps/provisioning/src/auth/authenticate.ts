import type { Env } from "../env.js";
import type { HostKind } from "../hosts.js";
import { type Principal, type Refusal, refusal } from "../principal.js";

/**
 * The authn step (design v7 4.2): on admin the `__Host-oa-admin` session
 * (W5a); on api `Bearer oat_` and, for `/mcp`, an OAuth access token, both
 * through tokenPrincipal, plus GitHub OIDC on staging (W5b). Host policy has
 * already refused the wrong credential type for the host. C4 fails closed.
 */
export async function authenticate(
  _req: Request,
  _env: Env,
  _host: HostKind,
): Promise<Principal | Refusal> {
  return refusal("unauthenticated");
}
