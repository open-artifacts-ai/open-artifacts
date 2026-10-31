import type { TokenScope } from "@oa/shared/provisioning";

// Server-rendered pages on the admin host for MCP consent (design v7
// 9A.3.2): the consent page, the same-origin bounce and message pages. No
// script; every client-supplied string is escaped.

/** The install's PAGE_CSP (apps/server/src/mcp/oauth.ts): no form-action, so the 302 to the client is not blocked. */
export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'";
/** The bounce page carries nothing to style or submit. */
export const BOUNCE_CSP =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );

export function html(
  body: string,
  status: number,
  headers?: Headers,
  csp: string = PAGE_CSP,
): Response {
  const h = new Headers(headers);
  h.set("content-type", "text/html; charset=utf-8");
  h.set("content-security-policy", csp);
  h.set("cache-control", "no-store");
  h.set("x-frame-options", "DENY");
  h.set("referrer-policy", "no-referrer");
  return new Response(body, { status, headers: h });
}

const STYLE = `:root{color-scheme:light dark;--bg:#eef0f3;--surface:#fff;--divider:#e0e3e8;--border:#bec4cd;--text:#15181c;--muted:#5f6670;--warn-soft:#fbf0d9;--danger:#a3261b}
@media (prefers-color-scheme:dark){:root{--bg:#131518;--surface:#1c1f23;--divider:#2c3037;--border:#3b414a;--text:#e9ebee;--muted:#9097a1;--warn-soft:#352914;--danger:#ff8a7f}}
*{box-sizing:border-box}body{margin:0;padding:0 16px;background:var(--bg);color:var(--text);font:400 14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:460px;margin:8vh auto;background:var(--surface);border-radius:8px;box-shadow:0 0 0 1px var(--border);padding:24px}
h1{margin:0 0 12px;font-size:20px;line-height:1.25;overflow-wrap:anywhere}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid var(--border);font-size:12px;margin-bottom:12px}
.badge.prod{color:var(--danger);border-color:var(--danger)}
dl{margin:0 0 16px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
.mono{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:12px}
.note{padding:8px 12px;border-radius:6px;background:var(--warn-soft);margin:0 0 16px}
fieldset{border:0;border-top:1px solid var(--divider);margin:0 0 12px;padding:8px 0 0}legend{color:var(--muted);font-size:12px;padding:0}
label{display:flex;gap:8px;padding:4px 0}small{color:var(--muted)}
.actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
button{height:36px;padding:0 16px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit;font-weight:500;cursor:pointer}
button.primary{background:var(--text);border-color:var(--text);color:var(--surface)}`;

const shell = (title: string, body: string, extraHead = "") =>
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">${extraHead}
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;

/** A small static page; `title` and `message` are escaped. */
export const messagePage = (title: string, message: string, status: number) =>
  html(
    shell(
      title,
      `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`,
    ),
    status,
  );

/**
 * 9A.3.2 step 3: a cross-site arrival carries no Strict cookie; this page's
 * same-origin navigation to `next` (the same URL plus b=1) does.
 */
export function bouncePage(next: string): Response {
  const href = escapeHtml(next);
  return html(
    shell(
      "Continue to Open Artifacts admin",
      `<h1>Continue to Open Artifacts admin</h1><p><a href="${href}">Continue</a></p>`,
      `<meta http-equiv="refresh" content="0;url=${href}">`,
    ),
    200,
    undefined,
    BOUNCE_CSP,
  );
}

/** Pre-checked: read and audit; write unchecked; delete and pii apart, never pre-checked. */
const SCOPE_ROWS: { scope: TokenScope; text: string; checked: boolean }[] = [
  { scope: "installs:read", text: "Can read installs, jobs and releases", checked: true },
  { scope: "audit:read", text: "Can read the audit log", checked: true },
  {
    scope: "installs:write",
    text: "Can create, upgrade, suspend and resume installs",
    checked: false,
  },
];
const SENSITIVE_ROWS: { scope: TokenScope; text: string }[] = [
  { scope: "installs:delete", text: "Can delete installs and purge failed creates" },
  { scope: "installs:pii", text: "Can read owner email" },
];

const box = (scope: TokenScope, text: string, checked: boolean) =>
  `<label><input type="checkbox" name="scope" value="${scope}"${checked ? " checked" : ""}><span>${escapeHtml(text)} <small class="mono">${scope}</small></span></label>`;

export type ConsentView = {
  prod: boolean;
  clientName: string;
  clientId: string;
  registeredMinutesAgo: number | null;
  redirectHost: string;
  loopback: boolean;
  /** When the grant chain ends: the admin session's end. */
  endsAt: number;
  handle: string;
  consentToken: string;
};

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

export function consentPage(v: ConsentView, headers: Headers): Response {
  const registered =
    v.registeredMinutesAgo === null
      ? ""
      : `<dt>Registered</dt><dd>registered ${v.registeredMinutesAgo} minutes ago</dd>`;
  const body = `<span class="badge${v.prod ? " prod" : ""}">${v.prod ? "Production" : "Staging"}</span>
<h1>Connect any AI agent to Open Artifacts admin</h1>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="request" value="${escapeHtml(v.handle)}">
<input type="hidden" name="consent" value="${escapeHtml(v.consentToken)}">
<p>Calls itself <b>${escapeHtml(v.clientName)}</b></p>
<dl><dt>Client id</dt><dd class="mono">${escapeHtml(v.clientId)}</dd>${registered}
<dt>Redirects to</dt><dd class="mono">${escapeHtml(v.redirectHost)}${v.loopback ? " (Local app)" : ""}</dd></dl>
<p class="note">Only continue if you just started this from your own agent.</p>
<fieldset><legend>What it can do</legend>${SCOPE_ROWS.map((r) => box(r.scope, r.text, r.checked)).join("")}</fieldset>
<fieldset><legend>Sensitive</legend>${SENSITIVE_ROWS.map((r) => box(r.scope, r.text, false)).join("")}</fieldset>
<p>Ends at ${hhmm(v.endsAt)} UTC, when your admin session ends.</p>
<div class="actions"><button type="submit" name="decision" value="deny">Deny</button><button type="submit" name="decision" value="approve" class="primary">Allow</button></div>
</form>`;
  return html(shell("Connect any AI agent to Open Artifacts admin", body), 200, headers);
}
