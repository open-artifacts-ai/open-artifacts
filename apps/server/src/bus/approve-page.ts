import { FAVICON_TAGS } from "../http/head.js";
import { html, type SafeHtml } from "../http/pages.js";

// The bus approval page (#1291): GET /bus/approve/<code> renders the form,
// POST decides, and the success screen follows. Server-rendered with no
// JavaScript, in the OAuth consent page's layout and tokens
// (design/screens/oauth-consent.html). Every value goes through the escaping
// `html` tag; the machine label is client-supplied.

const STYLE = `:root{color-scheme:light;
--bg:#eef0f3;--surface:#fff;--surface-2:#f6f7f9;--divider:#e0e3e8;--border:#bec4cd;--border-strong:#848b95;
--text:#15181c;--text-2:#454c56;--muted:#5f6670;--accent:#2350d0;--warn:#8a5a00;--warn-soft:#fbf0d9;--danger:#b42318;
--shadow:0 1px 0 rgba(20,24,30,.04),0 0 0 1px var(--border)}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;
--bg:#131518;--surface:#1c1f23;--surface-2:#212429;--divider:#2c3037;--border:#3b414a;--border-strong:#676e78;
--text:#e9ebee;--text-2:#b7bdc6;--muted:#9097a1;--accent:#7f9cff;--warn:#e7b44f;--warn-soft:#352914;--danger:#f97066;
--shadow:0 0 0 1px var(--border)}}
*{box-sizing:border-box}
html,body{margin:0}
body{min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:0 16px;background:var(--bg);color:var(--text);
font:400 13px/1.45 "Geist",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
svg{display:block;flex:none;width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.mono{font-family:"Geist Mono",ui-monospace,"SF Mono",Menlo,monospace}
header{width:100%;max-width:960px;height:56px;display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;letter-spacing:-.01em}
header span{margin-left:auto;font-weight:400;font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
main{flex:1;width:100%;display:flex;align-items:center;justify-content:center;padding:24px 0 64px}
.card{width:100%;max-width:440px;background:var(--surface);border-radius:8px;box-shadow:var(--shadow);padding:28px}
.client{display:flex;align-items:center;gap:12px;padding:12px;border-radius:6px;background:var(--surface-2);box-shadow:0 0 0 1px var(--divider);margin-bottom:20px}
.client .ico{width:36px;height:36px;border-radius:8px;background:var(--text);color:var(--surface);display:grid;place-items:center}
.client div{min-width:0;line-height:1.35}
.client b{display:block;font-weight:600;font-size:14px;overflow-wrap:anywhere}
.client small{display:block;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
h1{margin:0 0 6px;font-size:20px;line-height:1.25;font-weight:600;letter-spacing:-.02em;overflow-wrap:anywhere}
p{margin:0 0 16px;color:var(--text-2);overflow-wrap:anywhere}
p a{color:var(--accent)}
ul{list-style:none;margin:0 0 20px;padding:0;border-top:1px solid var(--divider)}
li{display:flex;gap:10px;padding:11px 2px;border-bottom:1px solid var(--divider)}
li svg{color:var(--accent);margin-top:1px}
li.no svg{color:var(--muted)}
li b{display:block;font-weight:500}
li small{display:block;color:var(--muted);font-size:12px}
.who{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;font-size:12px;color:var(--muted);margin-bottom:16px}
.who b{color:var(--text);font-weight:500;overflow-wrap:anywhere}
.who a{color:var(--text-2);margin-left:auto}
.note{display:flex;gap:8px;padding:8px 12px;border-radius:6px;background:var(--warn-soft);color:var(--text);font-size:12px;margin-bottom:20px}
.note svg{color:var(--warn);width:14px;height:14px;margin-top:1px}
.actions{display:flex;gap:8px;justify-content:flex-end}
button{height:36px;padding:0 16px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);
font:inherit;font-size:14px;font-weight:500;line-height:1;cursor:pointer}
button:hover{border-color:var(--border-strong)}
button.primary{background:var(--text);border-color:var(--text);color:var(--surface)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.foot{margin:16px 0 0;font-size:12px;color:var(--muted);text-align:center}
.muted{color:var(--muted);font-size:12px;margin:0}
.nw{white-space:nowrap}
.wrap{overflow-wrap:anywhere}
.field{display:block;font-weight:500;font-size:13px;margin:0 0 6px}
input.code{display:block;width:100%;height:40px;padding:0 12px;border-radius:6px;border:1px solid var(--border-strong);background:var(--surface);color:var(--text);font-size:18px;letter-spacing:.08em;text-transform:uppercase;margin:0 0 8px}
input.code::placeholder{color:var(--muted);letter-spacing:.08em}
input.code.bad{border-color:var(--danger)}
.error{color:var(--danger);font-size:12px;margin:0 0 12px}
@media (max-width:480px){.card{padding:20px}.actions button{flex:1}header span{display:none}}`;

const CHECK = html`<svg viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7"/></svg>`;
const CROSS = html`<svg viewBox="0 0 16 16"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>`;
const MACHINE_ICON = html`<span class="ico" aria-hidden="true"><svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="7.5" rx="1"/><path d="M5.5 13h5M8 10.5V13"/></svg></span>`;

// The head is module constants only (STYLE, FAVICON_TAGS), joined as
// strings; every request value goes through `html` (title, host, main).
const HEAD_START = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
`;
const HEAD_END = `
${FAVICON_TAGS}
<meta name="theme-color" content="#EEF0F3" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#131518" media="(prefers-color-scheme: dark)">
<style>${STYLE}</style>
</head>
`;

function shell(title: string, instanceHost: string, main: SafeHtml): string {
  return (
    HEAD_START +
    String(html`<title>${title} · Open Artifacts</title>`) +
    HEAD_END +
    String(html`<body>
<header>Open Artifacts<span class="mono">${instanceHost}</span></header>
<main>${main}</main>
</body>
</html>`)
  );
}

/** "Requested N minutes ago", next to the client-chosen label. */
export function requestedAgo(ageMs: number): string {
  const min = Math.floor(Math.max(0, ageMs) / 60_000);
  if (min < 1) return "Requested just now";
  return min === 1 ? "Requested 1 minute ago" : `Requested ${min} minutes ago`;
}

/** Labels up to this many characters never wrap; longer ones wrap anywhere (Design (b)). */
export const LABEL_NOWRAP_MAX = 32;

/** A client-supplied machine label: nowrap when short, else wrap anywhere. */
const label = (s: string): SafeHtml =>
  [...s].length <= LABEL_NOWRAP_MAX
    ? html`<span class="nw">${s}</span>`
    : html`<span class="wrap">${s}</span>`;
/** The user code never wraps: the person compares it with their terminal. */
const code = (s: string): SafeHtml => html`<span class="mono nw">${s}</span>`;

const WARN = html`<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M8 5v3.5M8 11h.01"/></svg>`;

export type EntryView = {
  instanceHost: string;
  userEmail: string;
  formAction: string;
  csrf: string;
  switchUrl: string;
  /** What the person typed, shown back after an error. */
  typed: string;
  error?: string;
};

/** The code entry form (Design's copy): one field, nothing about any machine. */
export function renderEntry(v: EntryView): string {
  return shell(
    "Connect a machine",
    v.instanceHost,
    html`<form class="card" method="post" action="${v.formAction}">
    <input type="hidden" name="csrf" value="${v.csrf}">
    <input type="hidden" name="step" value="code">
    <h1>Connect a machine</h1>
    <p>Type the code shown in the terminal where you started the setup. Only use a code from a setup you started yourself.</p>
    <label class="field" for="code">Code from your terminal</label>
    <input class="mono code${v.error ? " bad" : ""}" id="code" name="code" type="text" value="${v.typed}" placeholder="XXXX-XXXX" maxlength="32" autocomplete="off" spellcheck="false" autocapitalize="characters" autofocus required${v.error ? html` aria-invalid="true" aria-describedby="code-error"` : ""}>
    ${v.error ? html`<p class="error" id="code-error" role="alert">${v.error}</p>` : ""}
    <div class="who">Signed in as <b>${v.userEmail}</b><a href="${v.switchUrl}">Not you?</a></div>
    <div class="actions">
      <button type="submit" class="primary">Continue</button>
    </div>
  </form>`,
  );
}

export type ApproveView = {
  instanceName: string;
  instanceHost: string;
  /** Client-supplied at the device step. */
  label: string;
  /** Formatted, e.g. "AB2C-D3E4". */
  userCode: string;
  ageMs: number;
  /** Where the request came from (country name, readable network), or null. */
  country: string | null;
  network: string | null;
  userEmail: string;
  formAction: string;
  csrf: string;
  switchUrl: string;
};

/** "Requested just now from Germany, Deutsche Telekom AG" (no guess when unknown). */
function requested(v: ApproveView): string {
  const ago = requestedAgo(v.ageMs);
  if (!v.country) return ago;
  return v.network
    ? `${ago} from ${v.country}, ${v.network}`
    : `${ago} from ${v.country}`;
}

/** The confirm form, after a matching code: who is asking, from where, as whom, what it can do. */
export function renderApprove(v: ApproveView): string {
  return shell(
    `Connect ${v.label}`,
    v.instanceHost,
    html`<form class="card" method="post" action="${v.formAction}">
    <input type="hidden" name="csrf" value="${v.csrf}">
    <input type="hidden" name="step" value="decide">
    <input type="hidden" name="code" value="${v.userCode}">
    <div class="client">
      ${MACHINE_ICON}
      <div><b>${label(v.label)}</b><small>${requested(v)} · code ${code(v.userCode)}</small></div>
    </div>
    <h1>Connect ${label(v.label)} to Open Artifacts?</h1>
    <p>If you approve, this machine's agents can reach your agents on other machines, as you.</p>
    <ul>
      <li>${CHECK}<div><b>Connect your own agents on this machine</b><small>Its agents can message your agents on your other machines.</small></div></li>
      <li>${CHECK}<div><b>Stay connected until you revoke it</b><small>It keeps a token on that machine that only works for this.</small></div></li>
      <li class="no">${CROSS}<div><b>Nothing else</b><small>No artifacts, no API and no MCP access. It never reaches anyone else's agents.</small></div></li>
    </ul>
    <div class="who">Signed in as <b>${v.userEmail}</b><a href="${v.switchUrl}">Not you?</a></div>
    <div class="note" role="note">${WARN}<span>Only approve if you started this setup yourself. If you don't recognise where it came from, choose Deny.</span></div>
    <div class="actions">
      <button type="submit" name="decision" value="deny">Deny</button>
      <button type="submit" name="decision" value="approve" class="primary">Approve</button>
    </div>
  </form>`,
  );
}

export type ApprovedView = {
  instanceHost: string;
  label: string;
  userEmail: string;
  /** The instance's own /bus URL (origin from config, never the Host header). */
  busUrl: string;
};

/** Design's success copy (#1291), exactly. */
export function renderApproved(v: ApprovedView): string {
  return shell(
    "Machine connected",
    v.instanceHost,
    html`<div class="card">
    <h1>Machine connected</h1>
    <p>"${label(v.label)}" is connected to ${v.userEmail}. Its agents can now reach your agents on other machines.</p>
    <p>To revoke it, or choose which agents get a note when something is shared with you, go to <a href="${v.busUrl}">${v.busUrl}</a>.</p>
    <p class="muted">You can close this tab and go back to your terminal.</p>
  </div>`,
  );
}
