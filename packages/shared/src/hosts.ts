// Self-contained (no imports) so scripts/setup can run it under node's type
// stripping and apps/server can import it from @oa/shared: setup refuses a
// host pair with the same normalization the server routes by.

/** The host as the server compares it: trimmed, lowercased, no port, one trailing dot stripped. */
export const normalizeHost = (h: string): string =>
  h.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
