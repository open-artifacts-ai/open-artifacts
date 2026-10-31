/**
 * The 503 a paused or closing install answers from dispatch itself (design
 * v7 5.5); the install's script is never called. One copy constant per mode,
 * so Design's final copy is a one-line swap. Plain text only: no <, >, &,
 * quotes or em dashes (pinned by a test).
 */
export interface UnavailableCopy {
  readonly title: string;
  readonly body: string;
}

export const PAUSED_COPY: UnavailableCopy = Object.freeze({
  title: "This workspace is paused",
  body: "Its owner or the Open Artifacts team has paused it. Your work is kept. Try again later, or contact the person who invited you.",
});

export const CLOSED_COPY: UnavailableCopy = Object.freeze({
  title: "This workspace is closing",
  body: "It was deleted and will be removed for good soon. If this is a mistake, its owner can ask to restore it.",
});

// Inline styles only, nothing fetched; light by default, dark on request.
const STYLE =
  ":root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#57534e}" +
  "@media (prefers-color-scheme: dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e}}" +
  "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
  "background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif}" +
  "main{max-width:32rem;padding:24px 16px}" +
  "h1{font-size:1.5rem;line-height:1.25;margin:0 0 .75rem}" +
  "p{margin:0;color:var(--muted)}";

const page = (c: UnavailableCopy) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="robots" content="noindex"><title>${c.title}</title>` +
  `<style>${STYLE}</style></head><body><main><h1>${c.title}</h1>` +
  `<p>${c.body}</p></main></body></html>`;

const HEADERS = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/**
 * The same 503 for every method and path: the page when the client accepts
 * HTML, else one line of text; HEAD gets the headers only. Nothing in it
 * names the install, its script or the env, and no Retry-After is sent.
 */
export function unavailable(req: Request, mode: "paused" | "closed") {
  const copy = mode === "paused" ? PAUSED_COPY : CLOSED_COPY;
  const html = (req.headers.get("accept") ?? "")
    .toLowerCase()
    .includes("text/html");
  const body = html ? page(copy) : `${copy.title}. ${copy.body}\n`;
  return new Response(req.method === "HEAD" ? null : body, {
    status: 503,
    headers: {
      ...HEADERS,
      "content-type": html
        ? "text/html; charset=utf-8"
        : "text/plain; charset=utf-8",
    },
  });
}
