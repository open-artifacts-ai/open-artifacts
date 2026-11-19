// #2632: the one setup reminder email, three days after a member's first
// login with no agent connected, and its "Don't remind me" token. Words are
// the design's (https://artifacts.leourbina.com/a/wcL5Qbdtme52odvV, v6, "The
// words on each screen", 1).
import { deriveKey } from "../auth/keys.js";
import type { Env } from "../env.js";
import { escapeHtml } from "../mcp/template.js";
import { hmacSign, hmacVerify } from "../util/crypto.js";
import { SETUP_REMINDER_HTML, SETUP_REMINDER_TXT } from "./email-templates.js";
import { type EmailContent, fill, oneLine } from "./templates.js";

export const REMIND_COPY = {
  // The email's own words are in design/emails/setup-reminder.*.
  subject: "Your agent isn't connected to {{instance}} yet",
  confirmTitle: "Stop setup reminders from {{instance}}?",
  confirmButton: "Don't remind me",
  offTitle: "Setup reminders are off",
  offBody: "You won't get setup reminders from {{instance}}.",
  badTitle: "This link is not valid",
  badBody:
    "Open it again from the reminder email. If it still fails, ask your admin.",
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

/**
 * The reminder, on the invite email's template (design/emails/setup-reminder.*):
 * the design's subject and body, the setup line, and "Don't remind me".
 */
export function setupReminderEmail(p: {
  instance: string;
  recipient: string;
  /** The app origin (appOrigin); every link points only here. */
  origin: string;
  /** The line to paste (templates.ts setupLine). */
  setupLine: string;
  /** Absolute "Don't remind me" link on the app origin. */
  offUrl: string;
}): EmailContent {
  const url = new URL(p.origin);
  const off = new URL(p.offUrl);
  if (off.origin !== url.origin) throw new Error("off link off the app host");
  const values = {
    instanceName: oneLine(p.instance, 80),
    recipientEmail: oneLine(p.recipient, 320),
    appHost: url.host,
    logoUrl: new URL("/email/logo@2x.png", url.origin).href,
    setupLine: oneLine(p.setupLine, 2000),
    offUrl: off.href,
  };
  const line = escapeHtml(values.setupLine);
  return {
    subject: oneLine(
      fill(REMIND_COPY.subject, { instance: values.instanceName }),
      150,
    ),
    text: fill(SETUP_REMINDER_TXT, values),
    // The setup line may wrap only after a "/" (never inside "https").
    html: fill(SETUP_REMINDER_HTML, values, escapeHtml).replace(
      `>${line}<`,
      `>${line.replace(/\//g, "/<wbr>")}<`,
    ),
    headers: {
      "List-Unsubscribe": `<${off.href}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
