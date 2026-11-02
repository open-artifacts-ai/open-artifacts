/**
 * The 503 a paused or closing install answers from dispatch itself (design
 * v7 5.5); the install's script is never called. Design's W11 copy, one
 * constant per mode. Plain text only: no <, >, &,
 * quotes or em dashes (pinned by a test).
 */
export interface UnavailableCopy {
  readonly title: string;
  readonly body: string;
}

export const PAUSED_COPY: UnavailableCopy = Object.freeze({
  title: "This workspace is paused",
  body: "Nothing in it has been deleted. If you use this workspace, ask its admin when it will be back.",
});

export const CLOSED_COPY: UnavailableCopy = Object.freeze({
  title: "This workspace is closed",
  body: "If you use this workspace, ask its admin about it.",
});

// Design's W11 layout A. Inline styles and SVG only, nothing fetched; the
// colors are the design tokens (packages/ui tokens.css), light and dark.
const STYLE =
  ":root{color-scheme:light dark;--bg:#ffffff;--fg:#15181c;--muted:#5f6670;--sunken:#eceef1}" +
  "@media (prefers-color-scheme: dark){:root{--bg:#1c1f23;--fg:#e9ebee;--muted:#9097a1;--sunken:#181a1e}}" +
  "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
  "background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif}" +
  "main{max-width:32rem;padding:24px 16px;text-align:center;display:flex;flex-direction:column;align-items:center}" +
  ".icon{width:40px;height:40px;border-radius:12px;background:var(--sunken);color:var(--muted);" +
  "display:flex;align-items:center;justify-content:center;margin:0 0 14px}" +
  "h1{font-size:17px;font-weight:600;line-height:1.3;margin:0 0 6px}" +
  "p{margin:0;max-width:300px;color:var(--muted)}" +
  "footer{margin-top:22px;font-size:11.5px;color:var(--muted)}";

// 16px stroke icons, decorative.
const svg = (d: string) =>
  `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  paused: svg('<path d="M6 3.5v9M10 3.5v9"/>'),
  closed: svg(
    '<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  ),
} as const;

const page = (c: UnavailableCopy, mode: "paused" | "closed") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="robots" content="noindex"><title>${c.title}</title>` +
  `<style>${STYLE}</style></head><body><main>` +
  `<div class="icon">${ICONS[mode]}</div><h1>${c.title}</h1>` +
  `<p>${c.body}</p><footer>Open Artifacts</footer></main></body></html>`;

const HEADERS = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
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
  const body = html ? page(copy, mode) : `${copy.title}. ${copy.body}\n`;
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
