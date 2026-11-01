import type { Env } from "../env.js";
import { type Principal, type Refusal, refusal } from "../principal.js";
import { hmacB64, sameString } from "./crypto.js";

// Browser-write checks on the admin host (design v7 4.2, 4.5). Tenants share
// the registrable domain, so SameSite does not separate them: every non-GET
// browser request needs the exact Origin, Sec-Fetch-Site (when sent)
// same-origin, and the session's CSRF token.

const SAFE = new Set(["GET", "HEAD"]);

/** base64url(HMAC-SHA256(ADMIN_SESSION_KEY, "csrf\n" + sid)); /me returns it. */
export const csrfToken = (env: Env, sid: string) =>
  hmacB64(env.ADMIN_SESSION_KEY, `csrf\n${sid}`);

/**
 * Before authn, every non-GET admin-host request: `Origin` exactly
 * `https://admin.<app>`, and `Sec-Fetch-Site`, when present, `same-origin`.
 */
export function checkOrigin(req: Request, env: Env): Refusal | null {
  if (SAFE.has(req.method)) return null;
  if (req.headers.get("origin") !== `https://admin.${env.APP_DOMAIN}`)
    return refusal("csrf_failed");
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return refusal("csrf_failed");
  return null;
}

/**
 * After authn, every non-GET admin-host request: `x-csrf-token` equals the
 * session's token (computed at authn into `p.session.csrf`). A principal
 * without a session never passes.
 */
export function checkCsrf(
  req: Request,
  _env: Env,
  p: Principal,
): Refusal | null {
  if (SAFE.has(req.method)) return null;
  const want = p.session?.csrf;
  const got = req.headers.get("x-csrf-token");
  return want && got && sameString(got, want) ? null : refusal("csrf_failed");
}
