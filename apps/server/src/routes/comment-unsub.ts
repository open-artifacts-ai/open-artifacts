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
// emails (idempotent). GET and POST both do it (Product: no button).

const HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
};

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`;

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
  // GET turns it off too (Product's call: no button). POST is RFC 8058
  // one-click and the token may ride the URL or the form body.
  app.get(COMMENT_UNSUB_PATH, (c) => turnOff(c, c.req.query("t") ?? ""));
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
