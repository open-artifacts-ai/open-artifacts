/** Where sign-in lands when the return path is missing or unsafe. */
export const DEFAULT_RETURN = "/installs";

// Mirrors the server's rule: one leading "/", then printable ASCII, no "//" or "/\".
const SAFE = /^\/(?![/\\])[\x21-\x7e]*$/;

/**
 * A same-origin path to send someone to after sign-in, or "/installs". Same
 * rule as the server: printable ASCII only, not protocol-relative, and never
 * under /auth/.
 */
export const safeReturn = (raw: unknown): string => {
  if (typeof raw !== "string" || !SAFE.test(raw)) return DEFAULT_RETURN;
  if (raw.startsWith("/auth/")) return DEFAULT_RETURN;
  return raw;
};
