import { stmt } from "../db/stmt.js";
import {
  COMMENT_UNSUB_PATH,
  UNSUB_COPY,
  verifyUnsubToken,
} from "../email/comment-email.js";
import { escapeHtml } from "../mcp/template.js";
import type { AppType } from "./index.js";

// #1467 the unsubscribe link in comment emails. The token names one person
// and one purpose: the only thing it can do is turn off that person's comment
// emails (idempotent). GET shows a confirm page (a mail scanner opening the
// link changes nothing); POST does it (RFC 8058 one-click posts here too).

const HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

const page = (title: string, body: string, form = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${form}</body></html>`;

export function mountCommentUnsub(app: AppType): void {
  app.get(COMMENT_UNSUB_PATH, async (c) => {
    const t = c.req.query("t") ?? "";
    if (!(await verifyUnsubToken(c.env, t)))
      return c.html(
        page(UNSUB_COPY.badTitle, UNSUB_COPY.badBody),
        400,
        HEADERS,
      );
    const form = `<form method="post" action="${COMMENT_UNSUB_PATH}"><input type="hidden" name="t" value="${escapeHtml(t)}"><button type="submit">${escapeHtml(UNSUB_COPY.confirmButton)}</button></form>`;
    return c.html(
      page(UNSUB_COPY.confirmTitle, UNSUB_COPY.confirmBody, form),
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
    const userId = await verifyUnsubToken(c.env, t);
    if (!userId)
      return c.html(
        page(UNSUB_COPY.badTitle, UNSUB_COPY.badBody),
        400,
        HEADERS,
      );
    await stmt(c.env.DB, "update users set comment_email = 0 where id = ?")
      .bind(userId)
      .run();
    return c.html(
      page(UNSUB_COPY.doneTitle, UNSUB_COPY.doneBody),
      200,
      HEADERS,
    );
  });
}
