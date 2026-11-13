import { AUTH, SIGN_IN_PAGE } from "@oa/shared";
import type { Context } from "hono";
import { ApiError } from "../http/errors.js";
import { type AppEnv, BREAK_GLASS_MS } from "../http/middleware.js";

/** How recent the session's forced sign-in must be for a sensitive change (the break-glass window). */
export const REAUTH_FRESH_MS = BREAK_GLASS_MS;

/**
 * Whether this cookie session is a forced sign-in recent enough: the session
 * is new and its re-auth marker (`a`, set only by Google's max_age=0, Access's
 * prompt=login or an email code sign-in) is too. A plain silent sign-in has
 * no marker, so a fresh iat alone never passes (as bus/role-confirm.ts).
 */
export function freshReauth(c: Context<AppEnv>, now = Date.now()): boolean {
  const recent = (t: number | null | undefined) =>
    t !== null &&
    t !== undefined &&
    t >= now - REAUTH_FRESH_MS &&
    t <= now + 60_000;
  return recent(c.var.sessionIat) && recent(c.var.sessionAuthAt);
}

/** The forced sign-in that brings the member back to `next`. */
export function reauthUrl(c: Context<AppEnv>, next: string): string {
  const n = encodeURIComponent(next);
  if (c.var.authMethod === "google")
    return `${AUTH.loginGoogle}?reauth=1&next=${n}`;
  if (c.var.authMethod === "access")
    return `${AUTH.login}?via=access&reauth=1&next=${n}`;
  return `${SIGN_IN_PAGE}?next=${n}`;
}

/** 401 reauth_required (details { reauthUrl }) unless the session is a fresh forced sign-in. */
export function requireFreshReauth(
  c: Context<AppEnv>,
  next = "/settings/security",
): void {
  if (!freshReauth(c))
    throw new ApiError("reauth_required", "Confirm it's you: log in again", {
      reauthUrl: reauthUrl(c, next),
    });
}
