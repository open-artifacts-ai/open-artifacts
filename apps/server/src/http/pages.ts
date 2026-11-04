import type { Member } from "@oa/shared";
import type { Context } from "hono";
import type { Env } from "../env.js";
import { escapeHtml } from "../mcp/template.js";
import { hmacSign, hmacVerify } from "../util/crypto.js";
import { FAVICON_TAGS } from "./head.js";
import type { AppEnv } from "./middleware.js";

// Server-rendered app-host pages (OAuth consent, the bus approval page, the
// /bus page): one CSP, one response shape, one form CSRF token. Moved out of
// mcp/oauth.ts unchanged in behaviour (#1291).

/** No scripts, no external requests; inline styles only. */
export const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'";

/** A per-user HTML page: never cached, never framed, PAGE_CSP. */
export function pageResponse(
  body: string,
  status: number,
  headers?: Headers,
): Response {
  const h = new Headers(headers);
  h.set("content-type", "text/html; charset=utf-8");
  h.set("content-security-policy", PAGE_CSP);
  h.set("cache-control", "no-store");
  h.set("x-frame-options", "DENY");
  return new Response(body, { status, headers: h });
}

/** A small static page; `title` and `message` are escaped. */
export function messagePage(title: string, message: string, status: number) {
  return pageResponse(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)} — Open Artifacts</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#15181c;background:#eef0f3}@media (prefers-color-scheme:dark){body{color:#e9ebee;background:#131518}}</style>
${FAVICON_TAGS}
</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`,
    status,
  );
}

/** The signed-in browser user (session cookie only; Bearer tokens can't act on pages). */
export const sessionUser = (c: Context<AppEnv>): Member | null =>
  c.var.tokenId ? null : c.var.user;

/** How long a rendered form's CSRF token is accepted. */
export const FORM_CSRF_TTL_S = 600;

const csrfData = (scope: string, uid: string, handle: string, exp: number) =>
  `${scope}:${uid}:${handle}:${exp}`;

/**
 * A form's CSRF token, `{exp}.{hmac}`, bound to `scope` (the page kind, e.g.
 * "oauth-consent"), the session user and `handle` (what the form decides on:
 * a consent handle, a device user code), valid FORM_CSRF_TTL_S.
 */
export async function formCsrf(
  env: Pick<Env, "SESSION_SECRET">,
  scope: string,
  uid: string,
  handle: string,
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + FORM_CSRF_TTL_S;
  return `${exp}.${await hmacSign(env.SESSION_SECRET, csrfData(scope, uid, handle, exp))}`;
}

/** Constant-time; false for a malformed, foreign, expired or other-scope token. */
export async function checkFormCsrf(
  env: Pick<Env, "SESSION_SECRET">,
  scope: string,
  uid: string,
  handle: string,
  token: string,
): Promise<boolean> {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp <= Math.floor(Date.now() / 1000)) return false;
  return hmacVerify(
    env.SESSION_SECRET,
    csrfData(scope, uid, handle, exp),
    m[2] ?? "",
  );
}

/** Markup built by `html`: trusted when interpolated into another `html`. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

type Slot = SafeHtml | string | number | null | undefined | false | Slot[];

function slot(v: Slot): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(slot).join("");
  return escapeHtml(String(v));
}

/**
 * An escaping tagged template, like lit's: every interpolated string or
 * number is HTML-escaped; a nested `html` result (or an array of them) is
 * kept as markup. There is no raw slot.
 */
export function html(
  strings: TemplateStringsArray,
  ...values: Slot[]
): SafeHtml {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++)
    out += slot(values[i] as Slot) + (strings[i + 1] ?? "");
  return new SafeHtml(out);
}
