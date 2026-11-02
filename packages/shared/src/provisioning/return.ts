// One copy of the sign-in `return` rule for the admin panel and the API.

/**
 * The sign-in `return` rule (4.3), checked at /auth/start and again at the
 * callback: one leading slash (not `//` or `/\`), printable ASCII only, same
 * origin, never under /auth/. Anything else is /installs.
 */
export const RETURN_RE = /^\/(?![/\\])[\x21-\x7e]*$/;
export const RETURN_FALLBACK = "/installs";
export function safeReturn(
  ret: string | null | undefined,
  origin: string,
): string {
  if (!ret || ret.length > 2048 || !RETURN_RE.test(ret)) return RETURN_FALLBACK;
  let u: URL;
  try {
    u = new URL(ret, origin);
  } catch {
    return RETURN_FALLBACK;
  }
  if (u.origin !== new URL(origin).origin || u.pathname.startsWith("/auth/"))
    return RETURN_FALLBACK;
  return ret;
}
