import type { Context } from "hono";
import { stmt } from "../db/stmt.js";
import {
  OPTOUT_COPY,
  OPTOUT_COPY_HOSTED,
  SHARE_OPTOUT_PATH,
  verifyOptoutToken,
} from "../email/share-optout.js";
import { fill, oneLine, orgName } from "../email/templates.js";
import type { AppEnv } from "../http/middleware.js";
import { escapeHtml } from "../mcp/template.js";
import { hostedOptoutOn } from "../services/hosted-optout.js";
import { getSettings } from "../services/members.js";
import type { AppType } from "./index.js";

// #2590 "Don't email me again" in the outside share email. The token names
// one address and one purpose: the only thing it can do is stop share emails
// to that address (idempotent). POST does it; GET shows a button, so a mail
// scanner prefetching the link changes nothing. Self-contained: one opt-out
// covers this install only. A hosted-wide opt-out would be a call to the
// platform from turnOff (cloud work, not built).

const HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

const page = (title: string, body: string, form = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem}</style></head><body><h1>${escapeHtml(title)}</h1>${body ? `<p>${escapeHtml(body)}</p>` : ""}${form}</body></html>`;

/** The install's name for the page's words (its host without one). */
async function org(c: Context<AppEnv>): Promise<string> {
  const name = (await getSettings(c.env).catch(() => null))?.name;
  return oneLine(orgName(name, c.env.APP_HOST), 80);
}

const bad = (c: Context<AppEnv>) =>
  c.html(page(OPTOUT_COPY.badTitle, OPTOUT_COPY.badBody), 400, HEADERS);

export function mountShareOptout(app: AppType): void {
  app.get(SHARE_OPTOUT_PATH, async (c) => {
    const t = c.req.query("t") ?? "";
    if (!(await verifyOptoutToken(c.env, t))) return bad(c);
    const v = { org: await org(c) };
    // The hosted-wide wording while the platform's list is on (#2652): the
    // per-team wording otherwise.
    const copy = hostedOptoutOn(c.env) ? OPTOUT_COPY_HOSTED : OPTOUT_COPY;
    const form = `<form method="post" action="${SHARE_OPTOUT_PATH}"><input type="hidden" name="t" value="${escapeHtml(t)}"><button type="submit">${escapeHtml(fill(copy.confirmButton, v))}</button></form>`;
    return c.html(
      page(fill(copy.confirmTitle, v), fill(copy.confirmBody, v), form),
      200,
      HEADERS,
    );
  });
  // The button, or RFC 8058 one-click (List-Unsubscribe-Post) with the token
  // in the URL.
  app.post(SHARE_OPTOUT_PATH, async (c) => {
    let t = c.req.query("t") ?? "";
    if (!t) {
      const form = await c.req.parseBody().catch(() => ({}));
      const v = (form as Record<string, unknown>).t;
      t = typeof v === "string" ? v : "";
    }
    const hash = await verifyOptoutToken(c.env, t);
    if (!hash) return bad(c);
    await stmt(
      c.env.DB,
      "insert into email_optouts (address_hash, created_at) values (?1, ?2) on conflict (address_hash) do nothing",
    )
      .bind(hash, Date.now())
      .run();
    return c.html(
      page(
        fill(
          (hostedOptoutOn(c.env) ? OPTOUT_COPY_HOSTED : OPTOUT_COPY).doneTitle,
          { org: await org(c) },
        ),
        OPTOUT_COPY.doneBody,
      ),
      200,
      HEADERS,
    );
  });
}
