import type { Context } from "hono";
import { stmt } from "../db/stmt.js";
import {
  COMMENT_UNSUB_PATH,
  UNSUB_COPY,
  verifyUnsubToken,
} from "../email/comment-email.js";
import { fill, oneLine } from "../email/templates.js";
import type { AppEnv } from "../http/middleware.js";
import { escapeHtml } from "../mcp/template.js";
import { getSettings } from "../services/members.js";
import type { AppType } from "./index.js";

// #1467 the unsubscribe link in comment emails. The token names one person
// and one purpose: the only thing it can do is turn off that person's comment
// emails (idempotent). POST does it; GET shows a button (Product spec v3).

const HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

const page = (title: string, body: string, form = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${form}</body></html>`;

/** Turns the token's person's comment emails off (idempotent) and says so. */
async function turnOff(c: Context<AppEnv>, t: string) {
  const userId = await verifyUnsubToken(c.env, t);
  if (!userId)
    return c.html(page(UNSUB_COPY.badTitle, UNSUB_COPY.badBody), 400, HEADERS);
  await stmt(c.env.DB, "update users set comment_email = 0 where id = ?")
    .bind(userId)
    .run();
  const instance =
    (await getSettings(c.env).catch(() => null))?.name ?? "this instance";
  return c.html(
    page(
      UNSUB_COPY.offTitle,
      fill(UNSUB_COPY.offBody, { instance: oneLine(instance, 80) }),
    ),
    200,
    HEADERS,
  );
}

export function mountCommentUnsub(app: AppType): void {
  // GET only shows a button (a mail scanner opening the link changes
  // nothing). POST turns it off: the button, or RFC 8058 one-click with the
  // token in the URL.
  app.get(COMMENT_UNSUB_PATH, async (c) => {
    const t = c.req.query("t") ?? "";
    if (!(await verifyUnsubToken(c.env, t)))
      return c.html(
        page(UNSUB_COPY.badTitle, UNSUB_COPY.badBody),
        400,
        HEADERS,
      );
    const instance =
      (await getSettings(c.env).catch(() => null))?.name ?? "this instance";
    const form = `<form method="post" action="${COMMENT_UNSUB_PATH}"><input type="hidden" name="t" value="${escapeHtml(t)}"><button type="submit">${escapeHtml(UNSUB_COPY.confirmButton)}</button></form>`;
    return c.html(
      page(
        UNSUB_COPY.confirmTitle,
        fill(UNSUB_COPY.confirmBody, { instance: oneLine(instance, 80) }),
        form,
      ),
      200,
      HEADERS,
    );
  });
  app.post(COMMENT_UNSUB_PATH, async (c) => {
    let t = c.req.query("t") ?? "";
    if (!t) {
      const form = await c.req.parseBody().catch(() => ({}));
      const v = (form as Record<string, unknown>).t;
      t = typeof v === "string" ? v : "";
    }
    return turnOff(c, t);
  });
}
