// Headers on every browser-host response (design v7 4.5).

export const BROWSER_CSP =
  "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export const BROWSER_HEADERS = {
  "content-security-policy": BROWSER_CSP,
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
} as const;

/**
 * Sets the browser-host headers, overriding whatever the response had.
 * `ownCsp`: the MCP consent page sets its own CSP (9A.3.2), kept if present.
 */
export function browserHeaders(
  res: Response,
  { ownCsp = false }: { ownCsp?: boolean } = {},
): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(BROWSER_HEADERS)) {
    if (k === "content-security-policy" && ownCsp && out.headers.has(k))
      continue;
    out.headers.set(k, v);
  }
  return out;
}
