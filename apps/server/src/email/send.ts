import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { getSettings } from "../services/members.js";
import { sha256Hex } from "../util/crypto.js";
import type { EmailContent } from "./templates.js";

// Optional notification email via a Cloudflare Email Service `send_email`
// binding (EMAIL) and sender (EMAIL_FROM). Best effort: never throws, and
// any missing config, cap or send failure is just `false`.

/** Emails one inviter may trigger per UTC day. */
export const MAX_EMAILS_PER_USER_PER_DAY = 20;
/**
 * Invite and share emails per UTC day, instance-wide (protects the monthly
 * sending quota): EMAIL_DAILY_CAP, else this. Sign-in codes have their own
 * pool (auth/codes.ts), so invites can't starve sign-in.
 */
export const MAX_EMAILS_PER_DAY = 100;
const EMAIL_DAILY_CAP_MAX = 100_000;

export function emailDailyCap(env: Pick<Env, "EMAIL_DAILY_CAP">): number {
  const v = env.EMAIL_DAILY_CAP;
  if (!v || !/^[1-9]\d*$/.test(v)) return MAX_EMAILS_PER_DAY;
  const n = Number(v);
  return n <= EMAIL_DAILY_CAP_MAX ? n : MAX_EMAILS_PER_DAY;
}
/** Emails one recipient address may receive per UTC day, instance-wide. */
export const MAX_EMAILS_PER_RECIPIENT_PER_DAY = 5;
export const EMAIL_TIMEOUT_MS = 3000;
const ALL_KEY = "email:*";

// One plain addr-spec: no quotes, commas, semicolons, angle brackets, comments
// or whitespace, so the binding can never read `to` as a list or display name.
const SINGLE_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/;

/** Sender display name when the install has no usable name of its own. */
export const PRODUCT_NAME = "Open Artifacts";
/** Longest install name kept in the From display name, in code points. */
export const FROM_NAME_MAX = 64;

// Control characters (C0, DEL, C1), line and paragraph separators, lone
// surrogates, every format character (bidi controls, zero-width spaces, soft
// hyphen, word joiner, tag characters, ...) except U+200D (ZWJ, which emoji
// sequences need), and blank lookalikes (Hangul fillers, braille blank).
const UNSAFE_CHARS =
  /[\p{Cc}\p{Cs}\u2028\u2029\u115F\u1160\u3164\uFFA0\u2800]|(?!\u200D)\p{Cf}/gu;
// RFC 5322 specials (and backslash) that would force the phrase to be quoted.
const PHRASE_SPECIALS = /["\\<>@()[\]:;,.]/g;

/**
 * The install name made safe for a From display name: NFKC first (fullwidth
 * lookalikes become ASCII), then no control, format, line break or blank
 * lookalike characters, no RFC 5322 specials, whitespace collapsed, at most
 * FROM_NAME_MAX code points (a surrogate pair is never split). May be empty.
 */
export function cleanInstanceName(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  const s = raw
    .normalize("NFKC")
    // Line breaks, tabs and space separators separate words.
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029\p{Zs}]/gu, " ")
    .replace(UNSAFE_CHARS, "")
    .replace(PHRASE_SPECIALS, "")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(s).slice(0, FROM_NAME_MAX).join("").trim();
}

/** True if the cleaned name claims to be the product itself. */
const namesProduct = (name: string) =>
  name
    .replace(/[\s‍]/gu, "")
    .toLowerCase()
    .includes(PRODUCT_NAME.replace(/\s/g, "").toLowerCase());

/** Longest wait for the settings read in sendEmail before the default name. */
export const SETTINGS_READ_MS = 1000;

/** The settings name, or null on failure or after SETTINGS_READ_MS. */
async function settingsName(env: Env): Promise<string | null> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      getSettings(env).then(
        (s) => s.name,
        () => null,
      ),
      new Promise<null>((resolve) => {
        t = setTimeout(() => resolve(null), SETTINGS_READ_MS);
      }),
    ]);
  } finally {
    clearTimeout(t);
  }
}

// Bytes of UTF-8 per encoded word: 45 bytes is 60 base64 characters, so
// "=?UTF-8?B?" + 60 + "?=" stays within RFC 2047's 75.
const WORD_BYTES = 45;

/** RFC 2047 B encoding, split into words without splitting a character. */
function encodeWords(s: string): string {
  const enc = new TextEncoder();
  const words: string[] = [];
  let chunk: number[] = [];
  const flush = () => {
    if (!chunk.length) return;
    words.push(`=?UTF-8?B?${btoa(String.fromCharCode(...chunk))}?=`);
    chunk = [];
  };
  for (const ch of s) {
    const b = enc.encode(ch);
    if (chunk.length + b.length > WORD_BYTES) flush();
    chunk.push(...b);
  }
  flush();
  return words.join(" ");
}

/**
 * The From display name: "<install> via Open Artifacts", or just the
 * product name when the install name is unset, cleans to nothing, or
 * itself names the product ("Open Artifacts Security").
 * Non-ASCII (or anything a client could read as an encoded word) is RFC
 * 2047-encoded here, since the binding's docs don't say it encodes names.
 */
export function fromName(instance: string | null | undefined): string {
  const name = cleanInstanceName(instance);
  const phrase =
    !name || namesProduct(name) ? PRODUCT_NAME : `${name} via ${PRODUCT_NAME}`;
  return /^[\x20-\x7e]*$/.test(phrase) && !phrase.includes("=?")
    ? phrase
    : encodeWords(phrase);
}

export type EmailKind = "invite" | "share" | "code" | "space" | "directory";
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

class EmailTimeout extends Error {}

/** A short code for logs; never the message, which may name the recipient. */
function failReason(e: unknown): string {
  if (e instanceof EmailTimeout) return "timeout";
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && ERROR_CODE.test(code)
    ? code
    : "send_error";
}

// Structured logs carry the kind and messageId or reason only: never the
// recipient, sender, subject or body.
const logFailed = (kind: EmailKind, reason: string) =>
  console.warn(JSON.stringify({ evt: "email_failed", kind, reason }));

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

// Counts one unless the bucket's count is already at the cap (the row resets
// when the bucket changes: a UTC day here, finer for sign-in codes). RETURNING
// is empty when over the cap.
const TAKE = `insert into counters (key, n, day) values (?1, 1, ?2)
  on conflict (key) do update set
    n = case when counters.day = excluded.day then counters.n + 1 else 1 end,
    day = excluded.day
  where counters.day <> excluded.day or counters.n < ?3
  returning n`;

/** Daily cron: drops email and sign-in-code counters from before today (they reset anyway). */
export async function sweepEmailCounters(env: Env, now = Date.now()) {
  await env.DB.prepare(
    "delete from counters where (key like 'email:%' or key like 'code:%') and day < ?",
  )
    .bind(utcDay(now))
    .run();
}

/** A counter cap: key, max, and the bucket it counts in (a day, an hour, …). */
export type Cap = [key: string, max: number, bucket: string];

const REFUND =
  "update counters set n = n - 1 where key = ?1 and day = ?2 and n > 0";

/**
 * Takes one slot under each cap, in order, each an atomic conditional
 * upsert. All or nothing: at the first full cap the later caps are never
 * touched and the earlier slots are refunded, so a refusal burns no sibling
 * bucket. Returns the index of the refusing cap, or -1 when every slot was
 * taken.
 */
export async function takeAll(env: Env, caps: Cap[]): Promise<number> {
  for (let i = 0; i < caps.length; i++) {
    const [key, max, bucket] = caps[i] as Cap;
    const row = await stmt(env.DB, TAKE).bind(key, bucket, max).first();
    if (row) continue;
    if (i > 0)
      await env.DB.batch(
        caps.slice(0, i).map(([k, , b]) => stmt(env.DB, REFUND).bind(k, b)),
      );
    return i;
  }
  return -1;
}

/** Refunds one slot taken under each cap (a send that never happened). */
export async function refundAll(env: Env, caps: Cap[]): Promise<void> {
  if (caps.length === 0) return;
  await env.DB.batch(caps.map(([k, , b]) => stmt(env.DB, REFUND).bind(k, b)));
}

/** True if EMAIL and EMAIL_FROM are both configured. */
export const emailEnabled = (env: Env): boolean =>
  !!env.EMAIL && !!env.EMAIL_FROM;

/**
 * Sends `render()` to the (already validated) address `to` on behalf of
 * `userId`. Rendering runs inside the guard, so a template error is `false`.
 * With `artifactId`, one email per (artifact, recipient) per day, so removing
 * and re-adding a share can't re-mail. Counter keys never hold the address
 * (a SHA-256 hex stands in). Sign-in codes pass `caps: []`: auth/codes.ts
 * takes their own pool's slots first.
 */
export async function sendEmail(
  env: Env,
  userId: string | null,
  to: string,
  render: () => EmailContent,
  opts: {
    kind: EmailKind;
    artifactId?: string;
    /** The inviter's/sharer's address; dropped unless one plain address. */
    replyTo?: string;
    now?: number;
    /** Replaces the invite/share caps (sign-in codes). */
    caps?: Cap[];
    /**
     * The install name (settings name) the caller already read; required so
     * no caller forgets it. `undefined` reads settings here (bounded).
     */
    instance: string | null | undefined;
  },
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const { EMAIL, EMAIL_FROM } = env;
  if (!EMAIL || !EMAIL_FROM || !SINGLE_ADDRESS.test(to)) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let content: EmailContent;
  try {
    content = render();
  } catch {
    logFailed(opts.kind, "render");
    return false;
  }
  try {
    let caps = opts.caps;
    if (!caps) {
      const day = utcDay(now);
      const toKey = await sha256Hex(to.toLowerCase());
      caps = [
        [ALL_KEY, emailDailyCap(env), day],
        [`email:to:${toKey}`, MAX_EMAILS_PER_RECIPIENT_PER_DAY, day],
      ];
      if (userId)
        caps.push([`email:${userId}`, MAX_EMAILS_PER_USER_PER_DAY, day]);
      if (opts.artifactId)
        caps.push([`email:a:${opts.artifactId}:${toKey}`, 1, day]);
    }
    if ((await takeAll(env, caps)) !== -1) {
      logFailed(opts.kind, "rate_limited");
      return false;
    }
    const instance =
      opts.instance !== undefined ? opts.instance : await settingsName(env);
    // On timeout we report false, but delivery is only unconfirmed: the
    // email may still arrive.
    const { messageId } = await Promise.race([
      EMAIL.send({
        // A plain address gets "<install> via Open Artifacts" as its display
        // name (every hosted install shares one sender); anything else is
        // passed through as configured.
        from: SINGLE_ADDRESS.test(EMAIL_FROM)
          ? { email: EMAIL_FROM, name: fromName(instance) }
          : EMAIL_FROM,
        to,
        ...(opts.replyTo && SINGLE_ADDRESS.test(opts.replyTo)
          ? { replyTo: opts.replyTo }
          : {}),
        ...content,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new EmailTimeout()), EMAIL_TIMEOUT_MS);
      }),
    ]);
    console.log(
      JSON.stringify({ evt: "email_sent", kind: opts.kind, messageId }),
    );
    return true;
  } catch (e) {
    logFailed(opts.kind, failReason(e));
    return false;
  } finally {
    clearTimeout(timer);
  }
}
