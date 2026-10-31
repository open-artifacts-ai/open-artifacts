import type { ProvisioningEnv } from "@oa/shared/provisioning";

// Server-rendered pages on the admin host for MCP consent (design v7
// 9A.3.2), from Design's admin-consent handoff (W11 layout A): consent, the
// same-origin bounce, sign in, sign in again, and the message pages. No
// script, no external font or URL; every interpolated value is escaped.

/**
 * Design's PAGE_CSP for consent. No form-action, so the 302 to the client
 * is not blocked; the POST checks the consent token and Sec-Fetch-Site.
 */
export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";
/** The bounce page has styles and a link, nothing to submit. */
export const BOUNCE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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

/**
 * Replaces every `{{name}}` with its value, HTML-escaped. A placeholder
 * without a value throws, so no page ships with `{{` left in it.
 */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = values[k];
    if (v === undefined) throw new Error(`page placeholder ${k} has no value`);
    return escapeHtml(v);
  });
}

/** Design's shared stylesheet, light and dark. */
const STYLE = `:root{color-scheme:light;
--bg:#eef0f3;--surface:#fff;--surface-2:#f6f7f9;--divider:#e0e3e8;--border:#bec4cd;--border-strong:#848b95;
--text:#15181c;--text-2:#454c56;--muted:#5f6670;--accent:#2350d0;--warn:#8a5a00;--warn-soft:#fbf0d9;
--shadow:0 1px 0 rgba(20,24,30,.04),0 0 0 1px var(--border)}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;
--bg:#131518;--surface:#1c1f23;--surface-2:#212429;--divider:#2c3037;--border:#3b414a;--border-strong:#676e78;
--text:#e9ebee;--text-2:#b7bdc6;--muted:#9097a1;--accent:#7f9cff;--warn:#e7b44f;--warn-soft:#352914;
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
p{margin:0 0 16px;color:var(--text-2)}
ul{list-style:none;margin:0 0 20px;padding:0;border-top:1px solid var(--divider)}
li{display:flex;gap:10px;padding:11px 2px;border-bottom:1px solid var(--divider)}
li svg{color:var(--accent);margin-top:1px}
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
@media (max-width:480px){.card{padding:20px}.actions button{flex:1}header span.mono{display:none}}

.env{margin-left:8px;font:600 10.5px "Geist Mono",ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border-radius:5px;white-space:nowrap}
.env.prod{background:#fbe3e1;color:#a3261b}
.env.staging{background:var(--warn-soft);color:var(--warn)}
@media (prefers-color-scheme:dark){.env.prod{background:#3a1c1a;color:#ff8f84}}
li label{display:flex;gap:10px;width:100%;cursor:pointer}
li input{flex:none;width:16px;height:16px;margin:2px 0 0;accent-color:var(--accent)}
li .code{font-size:11px;color:var(--muted);margin-left:4px}
.client .ico{font-weight:600;font-size:14px}
a.button{display:inline-flex;align-items:center;height:36px;padding:0 16px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit;font-weight:500;text-decoration:none}
a.button.primary{background:var(--text);border-color:var(--text);color:var(--surface)}
a.button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}`;

/** What every page's header shows. */
export type Chrome = { env: ProvisioningEnv; adminHost: string };

const chromeValues = (c: Chrome) => ({
  env_class: c.env === "prod" ? "prod" : "staging",
  env_label: c.env === "prod" ? "Production" : "Staging",
  env_name: c.env === "prod" ? "production" : "staging",
  admin_host: c.adminHost,
});

const shell = (body: string, extraHead = "") => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">${extraHead}
<title>{{title}} · Open Artifacts admin</title>
<style>
${STYLE}
</style>
</head>
<body>
<header>Open Artifacts admin<span class="env {{env_class}}">{{env_label}}</span><span class="mono">{{admin_host}}</span></header>
<main>
${body}
</main>
</body>
</html>`;

const render = (c: Chrome, template: string, values: Record<string, string>) =>
  fill(template, { ...chromeValues(c), ...values });

const MESSAGE = shell(`  <div class="card">
    <h1>{{heading}}</h1>
    <p>{{message}}</p>
  </div>`);

/** A card with a heading and a line: every error, an invalid redirect_uri included. */
export const messagePage = (
  c: Chrome,
  title: string,
  message: string,
  status: number,
) => html(render(c, MESSAGE, { title, heading: title, message }), status);

// Design's form GET would drop the query from its action; a link keeps it.
const BOUNCE = shell(
  `  <div class="card">
    <h1>Continue to the admin panel</h1>
    <p>An agent sent you here from another site. Continue so your admin sign-in applies, then you can approve or deny it.</p>
    <div class="actions">
      <a class="button primary" href="{{continue_url}}">Continue</a>
    </div>
  </div>`,
  `\n<meta http-equiv="refresh" content="0;url={{continue_url}}">`,
);

/**
 * 9A.3.2 step 3: a cross-site arrival carries no Strict cookie; this page's
 * same-origin navigation to `next` (the same URL plus b=1) does.
 */
export const bouncePage = (c: Chrome, next: string) =>
  html(
    render(c, BOUNCE, { title: "Continue", continue_url: next }),
    200,
    undefined,
    BOUNCE_CSP,
  );

const SIGNIN = shell(`  <div class="card">
    <h1>Sign in to continue</h1>
    <p>An agent wants to connect to the {{env_name}} admin. Sign in with your platform admin account first.</p>
    <div class="actions">
      <a class="button primary" href="{{signin_url}}">Sign in with Google</a>
    </div>
  </div>`);

/** No admin session (9A.3.2 step 3, after the bounce or on a same-origin arrival). */
export const signinPage = (c: Chrome, signinUrl: string) =>
  html(render(c, SIGNIN, { title: "Sign in", signin_url: signinUrl }), 200);

const REAUTH = shell(`  <div class="card">
    <h1>Sign in again first</h1>
    <p>Your admin session ends in {{session_left}}, and the agent's access would end with it. Sign in again to give it up to 8 hours.</p>
    <div class="actions">
      <a class="button" href="{{cancel_url}}">Cancel</a>
      <a class="button primary" href="{{reauth_url}}">Sign in again</a>
    </div>
  </div>`);

/** "40 minutes", "1 minute": the session's time left, rounded down, at least 1. */
export const minutesLeft = (ms: number) => {
  const m = Math.max(1, Math.floor(ms / 60_000));
  return `${m} minute${m === 1 ? "" : "s"}`;
};

/** A session with under 60 minutes left (9A.3.2 step 4). */
export const reauthPage = (
  c: Chrome,
  v: { leftMs: number; cancelUrl: string; reauthUrl: string },
) =>
  html(
    render(c, REAUTH, {
      title: "Sign in again",
      session_left: minutesLeft(v.leftMs),
      cancel_url: v.cancelUrl,
      reauth_url: v.reauthUrl,
    }),
    200,
  );

// Design's one list of five. Read and audit are pre-checked; write, delete
// and pii (last) never are, whatever the client asks.
const CONSENT =
  shell(`  <form class="card" method="post" action="{{form_action}}">
    <input type="hidden" name="request" value="{{request}}">
    <input type="hidden" name="consent_token" value="{{consent_token}}">
    <div class="client">
      <span class="ico" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11.5v2"/></svg></span>
      <div><b>Calls itself "{{client_name}}"</b><small>Client <span class="mono">{{client_id}}</span> · registered {{registered_ago}} · redirects to <span class="mono">{{redirect_host}}</span>{{local_app}}</small></div>
    </div>
    <h1>Connect this agent to the {{env_name}} admin?</h1>
    <p>It acts as you, with only what you tick:</p>
    <ul>
      <li><label><input type="checkbox" name="scope" value="installs:read" checked><div><b>Read installs<span class="mono code">installs:read</span></b><small>Installs, jobs, releases and the status of the world.</small></div></label></li>
      <li><label><input type="checkbox" name="scope" value="audit:read" checked><div><b>Read the audit log<span class="mono code">audit:read</span></b><small>Owner emails stay hidden.</small></div></label></li>
      <li><label><input type="checkbox" name="scope" value="installs:write"><div><b>Create and change installs<span class="mono code">installs:write</span></b><small>Create, upgrade, roll back, pause, resume and retry.</small></div></label></li>
      <li><label><input type="checkbox" name="scope" value="installs:delete"><div><b>Delete and restore installs<span class="mono code">installs:delete</span></b><small>Soft delete with the typed slug, restore, and remove failed creates.</small></div></label></li>
      <li><label><input type="checkbox" name="scope" value="installs:pii"><div><b>See owner emails<span class="mono code">installs:pii</span></b><small>On installs and in the audit log.</small></div></label></li>
    </ul>
    <div class="who">Signed in as <b>{{admin_email}}</b><a href="{{switch_url}}">Not you?</a></div>
    <div class="note" role="note"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M8 5v3.5M8 11h.01"/></svg><span>Only approve if you just started this from your own agent.</span></div>
    <div class="actions">
      <button type="submit" name="decision" value="deny">Deny</button>
      <button type="submit" name="decision" value="approve" class="primary">Approve</button>
    </div>
    <p class="foot">Access ends when your admin session does, within 8 hours. Revoke it anytime in Agent tokens.</p>
  </form>`);

/** "just now", "1 minute ago", "3 minutes ago", "2 hours ago", "4 days ago". */
export function ago(seconds: number): string {
  const unit = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"} ago`;
  const m = Math.floor(Math.max(0, seconds) / 60);
  if (m < 1) return "just now";
  if (m < 60) return unit(m, "minute");
  if (m < 1440) return unit(Math.floor(m / 60), "hour");
  return unit(Math.floor(m / 1440), "day");
}

export type ConsentView = {
  clientName: string;
  clientId: string;
  /** Seconds since DCR, or null when the library has no date. */
  registeredSecondsAgo: number | null;
  redirectHost: string;
  loopback: boolean;
  adminEmail: string;
  /** Sign in as someone else: /auth/start back to this request. */
  switchUrl: string;
  handle: string;
  consentToken: string;
};

/** 9A.3.2 step 5, with its own headers (the library's binding cookie). */
export const consentPage = (
  c: Chrome,
  v: ConsentView,
  headers: Headers,
): Response =>
  html(
    render(c, CONSENT, {
      title: "Connect any AI agent",
      form_action: "/oauth/authorize",
      request: v.handle,
      consent_token: v.consentToken,
      client_name: v.clientName,
      client_id: v.clientId,
      registered_ago:
        v.registeredSecondsAgo === null
          ? "at an unknown time"
          : ago(v.registeredSecondsAgo),
      redirect_host: v.redirectHost,
      local_app: v.loopback ? " (Local app)" : "",
      admin_email: v.adminEmail,
      switch_url: v.switchUrl,
    }),
    200,
    headers,
  );
