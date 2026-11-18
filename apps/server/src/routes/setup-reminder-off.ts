import type { Context } from "hono";
import {
  REMIND_COPY,
  REMIND_OFF_PATH,
  verifyRemindOffToken,
} from "../email/setup-reminder.js";
import { fill, oneLine } from "../email/templates.js";
import type { AppEnv } from "../http/middleware.js";
import { escapeHtml } from "../mcp/template.js";
import { getSettings } from "../services/members.js";
import { remindOff } from "../services/setup-reminder.js";
import type { AppType } from "./index.js";

// #2632 "Don't remind me" in the setup reminder email. The token names one
// person and one purpose: it can only turn off that person's setup
// reminders (idempotent). GET shows a button (a mail scanner opening the
// link changes nothing); POST does it, the button or RFC 8058 one-click.

const HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

const page = (title: string, body: string, form = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem}</style></head><body><h1>${escapeHtml(title)}</h1>${body ? `<p>${escapeHtml(body)}</p>` : ""}${form}</body></html>`;

const instanceOf = async (c: Context<AppEnv>) =>
  oneLine(
    (await getSettings(c.env).catch(() => null))?.name ?? "this instance",
    80,
  );

const bad = (c: Context<AppEnv>) =>
  c.html(page(REMIND_COPY.badTitle, REMIND_COPY.badBody), 400, HEADERS);

export function mountRemindOff(app: AppType): void {
  app.get(REMIND_OFF_PATH, async (c) => {
    const t = c.req.query("t") ?? "";
    if (!(await verifyRemindOffToken(c.env, t))) return bad(c);
    const instance = await instanceOf(c);
    const form = `<form method="post" action="${REMIND_OFF_PATH}"><input type="hidden" name="t" value="${escapeHtml(t)}"><button type="submit">${escapeHtml(REMIND_COPY.confirmButton)}</button></form>`;
    return c.html(
      page(fill(REMIND_COPY.confirmTitle, { instance }), "", form),
      200,
      HEADERS,
    );
  });
  app.post(REMIND_OFF_PATH, async (c) => {
    let t = c.req.query("t") ?? "";
    if (!t) {
      const form = await c.req.parseBody().catch(() => ({}));
      const v = (form as Record<string, unknown>).t;
      t = typeof v === "string" ? v : "";
    }
    const userId = await verifyRemindOffToken(c.env, t);
    if (!userId) return bad(c);
    await remindOff(c.env, userId);
    const instance = await instanceOf(c);
    return c.html(
      page(REMIND_COPY.offTitle, fill(REMIND_COPY.offBody, { instance })),
      200,
      HEADERS,
    );
  });
}
