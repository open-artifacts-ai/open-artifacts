import type { Env } from "../env.js";
import { type Principal, type Refusal, refusal } from "../principal.js";

// Browser-write checks on the admin host (design v7 4.2, 4.5), W5a. Both fail
// closed until then, so W5a replaces a refusal rather than adding a check.

const SAFE = new Set(["GET", "HEAD"]);

/**
 * Before authn, every non-GET admin-host request: exact `Origin`, and
 * `Sec-Fetch-Site`, when present, `same-origin`. C4 refuses every write.
 */
export function checkOrigin(req: Request, _env: Env): Refusal | null {
  return SAFE.has(req.method) ? null : refusal("csrf_failed");
}

/**
 * After authn, every non-GET admin-host request: `x-csrf-token` =
 * base64url(HMAC-SHA256(ADMIN_SESSION_KEY, "csrf\n" + sid)). C4 refuses
 * every write.
 */
export function checkCsrf(
  req: Request,
  _env: Env,
  _p: Principal,
): Refusal | null {
  return SAFE.has(req.method) ? null : refusal("csrf_failed");
}
