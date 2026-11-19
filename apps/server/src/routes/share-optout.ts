import type { Context } from "hono";
import { stmt } from "../db/stmt.js";
import {
  OPTOUT_COPY,
  SHARE_OPTOUT_PATH,
  verifyOptoutToken,
} from "../email/share-optout.js";
import { fill, orgLabel } from "../email/templates.js";
import type { AppEnv } from "../http/middleware.js";
import { escapeHtml } from "../mcp/template.js";
import { audit } from "../services/audit.js";
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
  return orgLabel(name, c.env.APP_HOST);
}

const bad = (c: Context<AppEnv>) =>
  c.html(page(OPTOUT_COPY.badTitle, OPTOUT_COPY.badBody), 400, HEADERS);

/** The opt-out done page, with the recipient's way back. */
const donePage = async (c: Context<AppEnv>, t: string) => {
  const v = { org: await org(c) };
  return c.html(
    page(
      fill(OPTOUT_COPY.doneTitle, v),
      OPTOUT_COPY.doneBody,
      `<form method="post" action="${SHARE_OPTOUT_PATH}"><input type="hidden" name="t" value="${escapeHtml(t)}"><input type="hidden" name="action" value="undo"><button type="submit">${escapeHtml(OPTOUT_COPY.undoButton)}</button></form>`,
    ),
    200,
    HEADERS,
  );
};

const optedOut = async (c: Context<AppEnv>, hash: string) =>
  (await stmt(
    c.env.DB,
    "select 1 as x from email_optouts where address_hash = ?1",
  )
    .bind(hash)
    .first()) !== null;

export function mountShareOptout(app: AppType): void {
  app.get(SHARE_OPTOUT_PATH, async (c) => {
    const t = c.req.query("t") ?? "";
    const hash = await verifyOptoutToken(c.env, t);
    if (!hash) return bad(c);
    // Already opted out (a later visit to the same link): the done page, with
    // Undo. Never a write: a GET changes nothing.
    if (await optedOut(c, hash)) return donePage(c, t);
    const v = { org: await org(c) };
    const form = `<form method="post" action="${SHARE_OPTOUT_PATH}"><input type="hidden" name="t" value="${escapeHtml(t)}"><button type="submit">${escapeHtml(fill(OPTOUT_COPY.confirmButton, v))}</button></form>`;
    return c.html(
      page(
        fill(OPTOUT_COPY.confirmTitle, v),
        fill(OPTOUT_COPY.confirmBody, v),
        form,
      ),
      200,
      HEADERS,
    );
  });
  // The button, RFC 8058 one-click (List-Unsubscribe-Post) with the token in
  // the URL, or Undo (the form's action=undo with the token in the body).
  app.post(SHARE_OPTOUT_PATH, async (c) => {
    let t = c.req.query("t") ?? "";
    let action = "";
    const form = (await c.req.parseBody().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!t) t = typeof form.t === "string" ? form.t : "";
    if (typeof form.action === "string") action = form.action;
    const hash = await verifyOptoutToken(c.env, t);
    if (!hash) return bad(c);
    if (action === "undo") {
      // Only this address's row, by the token's hash. Idempotent: the audit
      // row (no hash, no address) is written only when a row was
      // there. This install's list only: a hosted-wide opt-out lives on the
      // platform's own /unsubscribe page and is not touched here.
      await c.env.DB.batch([
        audit(
          c.env,
          "settings.change",
          { type: "settings", id: "instance" },
          { kind: "system", id: null },
          {
            // No hash: an owner who knows an address could hash it and match the row (#2815).
            detail: { by: "recipient", optoutRemoved: true },
            when: {
              sql: "exists (select 1 from email_optouts where address_hash = ?)",
              args: [hash],
            },
          },
        ),
        stmt(
          c.env.DB,
          "delete from email_optouts where address_hash = ?1",
        ).bind(hash),
      ]);
      return c.html(
        page(fill(OPTOUT_COPY.undoneTitle, { org: await org(c) }), ""),
        200,
        HEADERS,
      );
    }
    await stmt(
      c.env.DB,
      "insert into email_optouts (address_hash, created_at) values (?1, ?2) on conflict (address_hash) do nothing",
    )
      .bind(hash, Date.now())
      .run();
    return donePage(c, t);
  });
}
