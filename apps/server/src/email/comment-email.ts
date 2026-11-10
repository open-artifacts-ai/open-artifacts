// Comment notice emails (#1467): the template and the unsubscribe token.
// Product's copy (spec ms8jhYp1q57oEpgq, v2), verbatim. Every user-facing
// string is in COPY below.
import { deriveKey } from "../auth/keys.js";
import type { Env } from "../env.js";
import { escapeHtml } from "../mcp/template.js";
import { hmacSign, hmacVerify } from "../util/crypto.js";
import { type EmailContent, fill, oneLine } from "./templates.js";

/** Why a person is emailed, most specific first: ask, mention, reply, thread. */
export type CommentEmailReason = "ask" | "mention" | "reply" | "thread";

const COPY = {
  subject: {
    thread: "{{author}} commented on {{title}}",
    reply: "{{author}} replied on {{title}}",
    mention: "{{author}} mentioned you on {{title}}",
    ask: "{{author}} asked you a question on {{title}}",
  },
  opening: {
    thread: "{{author}} commented on {{title}}:",
    reply: "{{author}} replied in a thread you're in on {{title}}:",
    mention: "{{author}} mentioned you on {{title}}:",
    ask: "{{author}} asked you a question on {{title}}. Pick an answer on the page:",
  },
  reason: {
    thread: "you own this page",
    reply: "you're in this thread",
    mention: "you were mentioned",
    ask: "the question is for you",
  },
  leftOut:
    "{{k}} more comments today weren't emailed. They're all on the page.",
  open: "Open the comment",
  window:
    "New replies in this thread for the next 15 minutes stay on the page, with no email.",
  because: "You're getting this because {{reason}}.",
  stop: "Stop comment emails",
  settings: "Change this in Settings",
  offTitle: "Comment emails are off.",
  offBody:
    "You won't get emails about comments on {{instance}}. Turn them back on in Settings.",
  badTitle: "This link is not valid",
  badBody: "The unsubscribe link is invalid or damaged.",
} as const;
export const UNSUB_COPY = COPY;

/** The unsubscribe route (GET and POST both turn comment emails off). */
export const COMMENT_UNSUB_PATH = "/auth/unsubscribe/comments";
const TOKEN_VERSION = "v1";
const PURPOSE = "comment-email-off";
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

const payload = (userId: string) => `${TOKEN_VERSION}:${PURPOSE}:${userId}`;

/**
 * `v1.<userId>.<hmac>`: names one person and one purpose (turn off comment
 * emails), nothing else. No expiry; a new version retires old ones.
 */
export async function signUnsubToken(
  env: Pick<Env, "SESSION_SECRET">,
  userId: string,
): Promise<string> {
  if (!USER_ID.test(userId)) throw new Error("invalid user id");
  const sig = await hmacSign(
    await deriveKey(env, "oa:comment-unsub"),
    payload(userId),
  );
  return `${TOKEN_VERSION}.${userId}.${sig}`;
}

/** The user id the token names, or null when malformed, tampered or another version. */
export async function verifyUnsubToken(
  env: Pick<Env, "SESSION_SECRET">,
  token: string,
): Promise<string | null> {
  const [v, userId, sig, ...rest] = token.split(".");
  if (v !== TOKEN_VERSION || !userId || !sig || rest.length) return null;
  if (!USER_ID.test(userId)) return null;
  const ok = await hmacVerify(
    await deriveKey(env, "oa:comment-unsub"),
    payload(userId),
    sig,
  );
  return ok ? userId : null;
}

export const EXCERPT_MAX = 300;
export const TITLE_MAX = 60;

/**
 * The comment as a plain-text excerpt: whitespace collapsed, cut to 300
 * characters, and any link made unclickable (scheme "://" and "www." are
 * broken), so only our own links are live.
 */
export function excerptOf(body: string): string {
  return oneLine(body, EXCERPT_MAX)
    .replace(/\b([a-z][a-z0-9+.-]*):\/\//gi, "$1[:]//")
    .replace(/\bwww\./gi, "www[.]");
}

export function commentEmail(p: {
  /** A person's name, or "{agent} ({person}'s agent)". */
  author: string;
  title: string;
  reason: CommentEmailReason;
  excerpt: string;
  /** Absolute links on the app origin. */
  url: string;
  unsubUrl: string;
  settingsUrl: string;
  /** Comments the daily cap left out since the last email. */
  leftOut: number;
}): EmailContent {
  const values: Record<string, string> = {
    author: oneLine(p.author, 120),
    title: oneLine(p.title, TITLE_MAX),
  };
  const opening = fill(COPY.opening[p.reason], values);
  const because = fill(COPY.because, { reason: COPY.reason[p.reason] });
  const left =
    p.leftOut > 0 ? fill(COPY.leftOut, { k: String(p.leftOut) }) : null;
  const text = [
    opening,
    `"${p.excerpt}"`,
    ...(left ? [left] : []),
    `${COPY.open}: ${p.url}\n${COPY.window}`,
    `${because}\n${COPY.stop}: ${p.unsubUrl}\n${COPY.settings}: ${p.settingsUrl}`,
  ].join("\n\n");
  const e = escapeHtml;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${e(opening)}</title></head>
<body style="margin:0;padding:24px;font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<p>${e(opening)}</p>
<p>"${e(p.excerpt)}"</p>
${left ? `<p>${e(left)}</p>\n` : ""}<p><a href="${e(p.url)}">${e(COPY.open)}</a><br>${e(COPY.window)}</p>
<p style="color:#5d636e">${e(because)}<br><a href="${e(p.unsubUrl)}">${e(COPY.stop)}</a><br><a href="${e(p.settingsUrl)}">${e(COPY.settings)}</a></p>
</body></html>
`;
  return {
    subject: oneLine(fill(COPY.subject[p.reason], values), 150),
    text,
    html,
    headers: {
      "List-Unsubscribe": `<${p.unsubUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
