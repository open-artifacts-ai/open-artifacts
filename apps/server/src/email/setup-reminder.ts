// #2632: the one setup reminder email, three days after a member's first
// login with no agent connected, and its "Don't remind me" token. Words are
// the design's (https://artifacts.leourbina.com/a/wcL5Qbdtme52odvV, v6, "The
// words on each screen", 1).
import { deriveKey } from "../auth/keys.js";
import type { Env } from "../env.js";
import { escapeHtml } from "../mcp/template.js";
import { hmacSign, hmacVerify } from "../util/crypto.js";
import { type EmailContent, fill, oneLine } from "./templates.js";

export const REMIND_COPY = {
  subject: "Your agent isn't connected to {{instance}} yet",
  body: "You joined {{instance}} three days ago. One step is left: paste this into your agent.",
  stop: "Don't remind me",
  confirmTitle: "Stop setup reminders from {{instance}}?",
  confirmButton: "Don't remind me",
  offTitle: "No more reminders.",
  offBody: "You won't get setup reminders from {{instance}}.",
  badTitle: "This link is not valid",
  badBody: "The link is invalid or damaged.",
} as const;

/** The "Don't remind me" route (GET shows a button, POST turns reminders off). */
export const REMIND_OFF_PATH = "/auth/unsubscribe/setup-reminder";

const TOKEN_VERSION = "v1";
const PURPOSE = "setup-reminder-off";
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const payload = (userId: string) => `${TOKEN_VERSION}:${PURPOSE}:${userId}`;

/** `v1.<userId>.<hmac>`: one person, one purpose (no setup reminders). */
export async function signRemindOffToken(
  env: Pick<Env, "SESSION_SECRET">,
  userId: string,
): Promise<string> {
  if (!USER_ID.test(userId)) throw new Error("invalid user id");
  const sig = await hmacSign(
    await deriveKey(env, "oa:setup-remind-off"),
    payload(userId),
  );
  return `${TOKEN_VERSION}.${userId}.${sig}`;
}

/** The user id the token names, or null when malformed, tampered or another version. */
export async function verifyRemindOffToken(
  env: Pick<Env, "SESSION_SECRET">,
  token: string,
): Promise<string | null> {
  const [v, userId, sig, ...rest] = token.split(".");
  if (v !== TOKEN_VERSION || !userId || !sig || rest.length) return null;
  if (!USER_ID.test(userId)) return null;
  const ok = await hmacVerify(
    await deriveKey(env, "oa:setup-remind-off"),
    payload(userId),
    sig,
  );
  return ok ? userId : null;
}

/** The reminder: the design's words, the setup line, and "Don't remind me". */
export function setupReminderEmail(p: {
  instance: string;
  /** The line to paste (templates.ts setupLine). */
  setupLine: string;
  /** Absolute "Don't remind me" link on the app origin. */
  offUrl: string;
}): EmailContent {
  const values = { instance: oneLine(p.instance, 80) };
  const subject = oneLine(fill(REMIND_COPY.subject, values), 150);
  const body = fill(REMIND_COPY.body, values);
  const e = escapeHtml;
  const text = `${body}\n\n${p.setupLine}\n\n--\n\n${REMIND_COPY.stop}: ${p.offUrl}\n`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${e(subject)}</title></head>
<body style="margin:0;padding:24px;font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<p>${e(body)}</p>
<p style="padding:10px 12px;border:1px solid #E0E3E8;border-radius:6px;font:13px/20px ui-monospace,Menlo,Consolas,monospace;word-break:break-all">${e(p.setupLine)}</p>
<p style="color:#5d636e"><a href="${e(p.offUrl)}">${e(REMIND_COPY.stop)}</a></p>
</body></html>`;
  return {
    subject,
    text,
    html,
    headers: {
      "List-Unsubscribe": `<${p.offUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
