// Comment notice emails (#1467): the template and the unsubscribe token.
// Every user-facing string is in COPY below.

import { deriveKey } from "../auth/keys.js";
import type { Env } from "../env.js";
import { escapeHtml } from "../mcp/template.js";
import { hmacSign, hmacVerify } from "../util/crypto.js";
import { type EmailContent, fill, oneLine } from "./templates.js";

// copy: pending Product (#1467)
const COPY = {
  newThread: "{{who}} commented on {{title}}",
  reply: "{{who}} replied on {{title}}",
  textBody: `{{lead}}

Open the conversation: {{url}}

You get this because you own this page or took part in this thread. At most one email per thread every 15 minutes.

Stop emails about comments: {{unsubUrl}}
`,
  htmlBody: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>{{lead}}</title></head>
<body style="margin:0;padding:24px;font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<p>{{lead}}</p>
<p><a href="{{url}}">Open the conversation</a></p>
<p style="color:#5d636e">You get this because you own this page or took part in this thread. At most one email per thread every 15 minutes. <a href="{{unsubUrl}}">Stop emails about comments</a></p>
</body></html>
`,
  leadNew: "{{who}} started a thread on {{title}}.",
  leadReply: "{{who}} replied in a thread on {{title}}.",
  confirmTitle: "Stop comment emails?",
  confirmBody: "You will no longer get emails about comments.",
  confirmButton: "Stop comment emails",
  doneTitle: "Comment emails are off",
  doneBody: "You will no longer get emails about comments.",
  badTitle: "This link is not valid",
  badBody: "The unsubscribe link is invalid or damaged.",
} as const;
export const UNSUB_COPY = COPY;

/** The unsubscribe route (GET confirm page, POST one-click). */
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

export function commentEmail(p: {
  /** The comment's author's display name. */
  who: string;
  title: string;
  reply: boolean;
  /** Absolute links on the app origin. */
  url: string;
  unsubUrl: string;
}): EmailContent {
  const values: Record<string, string> = {
    who: oneLine(p.who, 80),
    title: oneLine(p.title, 200),
    url: p.url,
    unsubUrl: p.unsubUrl,
  };
  const lead = fill(p.reply ? COPY.leadReply : COPY.leadNew, values);
  const v = { ...values, lead };
  return {
    subject: oneLine(fill(p.reply ? COPY.reply : COPY.newThread, values), 150),
    text: fill(COPY.textBody, v),
    html: fill(COPY.htmlBody, v, escapeHtml),
    headers: {
      "List-Unsubscribe": `<${p.unsubUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
