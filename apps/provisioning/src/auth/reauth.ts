import type { Principal } from "../principal.js";

// Recent sign-in for R11 purge of a `deleting` install (design v7 4.2, 4.3):
// the session's authAt within 10 min; else 403 `reauth_required`, and the
// panel sends the admin to /auth/start?reauth=1 (the broker asks Google for
// max_age=0; the callback checks auth_time).

export const REAUTH_MAX_AGE_MS = 10 * 60_000;

export const hasRecentAuth = (p: Principal, now: number) =>
  typeof p.authAt === "number" && now - p.authAt <= REAUTH_MAX_AGE_MS;

/** The sign-in URL for a fresh Google sign-in that comes back to `ret`. */
export const reauthPath = (ret: string) =>
  `/auth/start?reauth=1&return=${encodeURIComponent(ret)}`;
