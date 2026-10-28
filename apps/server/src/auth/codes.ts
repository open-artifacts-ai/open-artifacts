import { normalizeEmail } from "@oa/auth-core";
import { CODE_POLICY } from "@oa/shared";
import { stmt } from "../db/stmt.js";
import {
  type Cap,
  emailEnabled,
  refundAll,
  sendEmail,
  takeAll,
} from "../email/send.js";
import { loginCodeEmail } from "../email/templates.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { codeEligibility } from "../services/identity.js";
import { getSettings } from "../services/members.js";
import { noteTestOtp } from "../test-hooks/index.js";
import { b64urlDecode, hmacSign } from "../util/crypto.js";
import { logAuth } from "./audit.js";
import type { AuthConfig } from "./config.js";
import { deriveKey, MIN_SECRET_LENGTH } from "./keys.js";

// Emailed one-time sign-in codes (P2). One row per request, keyed by HMACs
// (no plaintext email or code at rest), 8 digits, 10 minutes, 5 attempts per
// request enforced atomically in D1. Limits that count every well-formed
// address (enumeration resistance) run in the request; the pool and the send
// caps only on a real send.
//
// Every hard per-address limit is keyed per (address, network), network =
// IPv4 /24 or IPv6 /64, so a stranger elsewhere can never use up the
// victim's own network's allowance. Cross-network per-address counts are
// soft: logged and alerted as code_abuse, never refused. Against a
// distributed attacker (many networks) the bound is Turnstile, which is
// required on every code request whenever it's configured, plus the per-IP
// day cap and the code pool.

/** Server-only limits; CODE_POLICY (length, TTL, resend, attempts) is #359's. */
export const CODE_LIMITS = {
  /** Requests per (address, IP) per 10 minutes: also the resend floor. */
  perEmailIpPer10Min: 3,
  /** Requests per (address, network) per hour. */
  perEmailNetPerHour: 10,
  /** Requests per address per hour, across networks: code_abuse here (soft, never refused). */
  perEmailPerHourAlert: 10,
  /** Real sends per (address, network) per hour. */
  sendsPerEmailNetPerHour: 3,
  /** Real sends per (address, network) per UTC day. */
  sendsPerEmailNetPerDay: 5,
  /** Real sends per address per UTC day, across networks: code_abuse here (soft, never refused). */
  sendsPerEmailPerDayAlert: 25,
  /** Seconds between two real sends to one (address, network). */
  resendSec: 60,
  /** Requests per IP per UTC day. */
  perIpPerDay: 50,
  /** Failed verifications per IP per hour. */
  failsPerIpPerHour: 30,
} as const;

// `false` in release builds (build-flags.d.ts): no reference to test-hooks/.
const noteOtp =
  typeof __OA_TEST_HOOKS_ALLOWED__ !== "undefined" &&
  __OA_TEST_HOOKS_ALLOWED__ === true &&
  noteTestOtp;

const TTL_MS = CODE_POLICY.ttlSec * 1000;
const MAX_U32_UNBIASED = 4_200_000_000; // largest multiple of 10^8 below 2^32
// Compared when no row matched, so the work is the same either way.
const DUMMY_HASH = "A".repeat(43);

type BucketKind = "day" | "hour" | "tenMin";

/** The counters.day bucket for `now` (UTC): "YYYY-MM-DD", "…THH", "…THH:M". */
export function counterBucket(kind: BucketKind, now: number): string {
  const iso = new Date(now).toISOString();
  if (kind === "day") return iso.slice(0, 10);
  if (kind === "hour") return iso.slice(0, 13);
  return iso.slice(0, 15); // tens of minutes
}

const BUCKET_MS: Record<BucketKind, number> = {
  day: 86_400_000,
  hour: 3_600_000,
  tenMin: 600_000,
};
const retryAfter = (kind: BucketKind, now: number) =>
  Math.max(1, Math.ceil((BUCKET_MS[kind] - (now % BUCKET_MS[kind])) / 1000));

/**
 * The code keys, or 503 `code_unavailable` when the install's SESSION_SECRET
 * is under 32 characters: HKDF can't key the codes then (the raw secret only
 * keeps old session and state cookies readable), so codes are switched off
 * rather than failing with a 500 on every request.
 */
export async function codesKey(
  env: Env,
  label: "oa:login-codes" | "oa:code-cookie" | "oa:code-email",
): Promise<string> {
  const s = env.SESSION_SECRET;
  if (typeof s !== "string" || s.length < MIN_SECRET_LENGTH)
    throw new ApiError(
      "code_unavailable",
      "Code sign-in is unavailable on this install",
    );
  return deriveKey(env, label);
}

/** HMAC of the normalized address: the row key and the counter key part. */
export async function emailKey(env: Env, email: string): Promise<string> {
  const e = normalizeEmail(email) ?? email.trim().toLowerCase();
  return hmacSign(await codesKey(env, "oa:login-codes"), `email:${e}`);
}

/** An IPv4-mapped IPv6 address (::ffff:a.b.c.d) as plain IPv4; else null. */
function mappedV4(h: string[]): string | null {
  if (h.slice(0, 5).some((x) => x !== "0000") || h[5] !== "ffff") return null;
  const hi = Number.parseInt(h[6] as string, 16);
  const lo = Number.parseInt(h[7] as string, 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

/** Expands an IPv6 address to 8 four-digit hextets; null when it isn't one. */
function ipv6Hextets(ip: string): string[] | null {
  const a = (ip.split("%")[0] ?? "").toLowerCase();
  if (!a.includes(":") || !/^[0-9a-f:.]+$/.test(a)) return null;
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const part = (h: string | undefined) => (h ? h.split(":") : []);
  const head = part(halves[0]);
  const tail = part(halves[1]);
  const end = halves.length === 2 ? tail : head;
  const last = end[end.length - 1] ?? "";
  if (last.includes(".")) {
    const o = last
      .split(".")
      .map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : -1));
    if (o.length !== 4 || o.some((x) => x < 0 || x > 255)) return null;
    const [b0, b1, b2, b3] = o as [number, number, number, number];
    end.splice(
      end.length - 1,
      1,
      ((b0 << 8) | b1).toString(16),
      ((b2 << 8) | b3).toString(16),
    );
  }
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const all = [...head, ...new Array<string>(fill).fill("0"), ...tail];
  if (all.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  return all.map((h) => h.padStart(4, "0"));
}

/**
 * The client network a counter keys on: IPv6 by its /64 (one host usually
 * holds the whole /64); IPv4 whole, or by its /24 with `v4Net`. IPv4-mapped
 * IPv6 (::ffff:a.b.c.d) keys as the IPv4 address.
 */
export function ipNet(ip: string, v4Net = false): string {
  const v6 = ipv6Hextets(ip);
  const v4 = v6 && mappedV4(v6);
  if (v4) return ipNet(v4, v4Net);
  if (v6) return `${v6.slice(0, 4).join(":")}::/64`;
  if (v4Net && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip))
    return `${ip.split(".").slice(0, 3).join(".")}.0/24`;
  return ip;
}

const shortIpHmac = async (env: Env, v: string) =>
  (await hmacSign(await codesKey(env, "oa:login-codes"), v)).slice(0, 22);

/**
 * HMAC of the client IP (IPv6 by its /64), shortened: counter keys never
 * hold the IP either.
 */
export async function ipKey(env: Env, ip: string): Promise<string> {
  return shortIpHmac(env, `ip:${ipNet(ip)}`);
}

/** HMAC of the client's network (IPv4 /24 or IPv6 /64), for per-(address, network) caps. */
export async function netKey(env: Env, ip: string): Promise<string> {
  return shortIpHmac(env, `net:${ipNet(ip, true)}`);
}

/** Constant-time equality of two HMACs (both 32 bytes). */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

const codeHash = async (env: Env, ek: string, rid: string, code: string) =>
  hmacSign(await codesKey(env, "oa:login-codes"), `${ek}:${rid}:${code}`);

/** Exported for the distribution test. */
export function randomCode(): string {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const n = buf[0] as number;
    if (n < MAX_U32_UNBIASED)
      return String(n % 100_000_000).padStart(CODE_POLICY.length, "0");
  }
}

// A soft counter: counts in the bucket and never refuses; returns the count.
const BUMP = `insert into counters (key, n, day) values (?1, 1, ?2)
  on conflict (key) do update set
    n = case when counters.day = excluded.day then counters.n + 1 else 1 end,
    day = excluded.day
  returning n`;

async function bump(env: Env, key: string, bucket: string): Promise<number> {
  const r = await stmt(env.DB, BUMP).bind(key, bucket).first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * Request limits that count every well-formed address, eligible or not, so a
 * 429 says nothing about who can sign in: per IP per day, per (address, IP)
 * per 10 minutes, per (address, network) per hour. Taken in that order, all
 * or nothing: a refusal consumes no other bucket, so one IP can't burn
 * another address's caps, and nothing keyed only by the address refuses, so
 * strangers elsewhere can't lock the victim's network out. Per address
 * across networks is soft (code_abuse at the alert count); Turnstile is the
 * bound on distributed attackers. Address refusals report scope "email"
 * (#359).
 */
export async function takeRequestSlot(
  env: Env,
  _cfg: AuthConfig,
  ek: string,
  ip: string,
  now = Date.now(),
): Promise<
  { ok: true } | { ok: false; retryAfter: number; scope: "ip" | "email" }
> {
  const ik = await ipKey(env, ip);
  const nk = await netKey(env, ip);
  const refused = await takeAll(env, [
    [`code:ip:${ik}`, CODE_LIMITS.perIpPerDay, counterBucket("day", now)],
    [
      `code:eip:${ek}:${ik}`,
      CODE_LIMITS.perEmailIpPer10Min,
      counterBucket("tenMin", now),
    ],
    [
      `code:en:${ek}:${nk}`,
      CODE_LIMITS.perEmailNetPerHour,
      counterBucket("hour", now),
    ],
  ]);
  if (refused === 0)
    return { ok: false, retryAfter: retryAfter("day", now), scope: "ip" };
  if (refused === 1)
    return { ok: false, retryAfter: retryAfter("tenMin", now), scope: "email" };
  if (refused === 2)
    return { ok: false, retryAfter: retryAfter("hour", now), scope: "email" };
  const n = await bump(env, `code:e:${ek}`, counterBucket("hour", now));
  if (n === CODE_LIMITS.perEmailPerHourAlert)
    logAuth({ evt: "code_abuse", scope: "email" });
  return { ok: true };
}

/**
 * Stores a new code for (ek, rid) and returns it. A row already under that
 * id (a resend for the same pending request, review item 13) is replaced:
 * new hash, expiry and attempts. `gen` is for tests only.
 */
export async function createCode(
  env: Env,
  ek: string,
  rid: string,
  now = Date.now(),
  gen: () => string = randomCode,
): Promise<string> {
  const code = gen();
  await stmt(
    env.DB,
    `insert into login_codes (email_key, request_id, code_hash, expires_at, created_at)
     values (?1, ?2, ?3, ?4, ?5)
     on conflict (email_key, request_id) do update set
       code_hash = excluded.code_hash, expires_at = excluded.expires_at,
       attempts = 0, created_at = excluded.created_at`,
  )
    .bind(ek, rid, await codeHash(env, ek, rid, code), now + TTL_MS, now)
    .run();
  return code;
}

type CodeRow = {
  code_hash: string;
  expires_at: number;
  attempts: number;
  created_at: number;
};

/** Every way one deliverCode call ends; "error" is it throwing (the route logs that). */
export type CodeSendOutcome =
  | "sent"
  | "email_off"
  | "ineligible"
  | "pool_full"
  | "capped"
  | "resend_wait"
  | "send_failed"
  | "error";

const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
/** An exception's class name only (never its message), or "unknown". */
export function errorClass(e: unknown): string {
  const name =
    typeof e === "object" && e !== null
      ? (e as { constructor?: { name?: unknown } }).constructor?.name
      : undefined;
  return typeof name === "string" && CLASS_NAME.test(name) ? name : "unknown";
}

/**
 * The one code_send line per deliverCode call: the outcome, and for "error"
 * the exception's class. Never the address, its key or the code.
 */
export function logCodeSend(outcome: CodeSendOutcome, error?: string): void {
  console.log(JSON.stringify({ evt: "code_send", outcome, error }));
}

// One real send per (address, network) per resendSec, sliding: n holds the last send's
// time (ms); day is the UTC day, so the daily sweep drops old rows.
const RESEND = `insert into counters (key, n, day) values (?1, ?2, ?3)
  on conflict (key) do update set n = excluded.n, day = excluded.day
  where counters.n <= excluded.n - ?4
  returning n`;

/**
 * The real send, after the response (waitUntil): eligibility, then the send
 * caps (per (address, network) per hour and per day) and the code pool, all
 * or nothing and only now, then the per-(address, network) 60 s resend gate
 * (refunding the caps when it refuses), then the row and the email. Sends to
 * one address across networks are soft: counted, code_abuse at the alert
 * count, never refused, so no stranger can stop the victim's own network
 * getting codes. Null when nothing was sent; the route answers the same 202
 * either way. A failed send deletes its row, or puts back the code a
 * resend replaced.
 */
export async function deliverCode(
  env: Env,
  cfg: AuthConfig,
  email: string,
  ek: string,
  requestId: string,
  ip: string,
  now = Date.now(),
): Promise<{ requestId: string } | null> {
  /** Logs (and, in test builds, records) why nothing was sent. */
  const none = async (outcome: CodeSendOutcome): Promise<null> => {
    logCodeSend(outcome);
    if (noteOtp) await noteOtp(env, email, ek, outcome);
    return null;
  };
  if (!emailEnabled(env)) return none("email_off");
  const to = normalizeEmail(email);
  if (!to) return none("ineligible");
  if ((await codeEligibility(env, cfg, to)).kind === "none")
    return none("ineligible");
  const day = counterBucket("day", now);
  const nk = await netKey(env, ip);
  const caps: Cap[] = [
    [
      `code:sentn:${ek}:${nk}`,
      CODE_LIMITS.sendsPerEmailNetPerHour,
      counterBucket("hour", now),
    ],
    [`code:sentnd:${ek}:${nk}`, CODE_LIMITS.sendsPerEmailNetPerDay, day],
    ["code:*", cfg.codeEmailsPerDay, day],
  ];
  const refused = await takeAll(env, caps);
  if (refused === caps.length - 1) return none("pool_full");
  if (refused !== -1) return none("capped");
  const gate = await stmt(env.DB, RESEND)
    .bind(`code:rs:${ek}:${nk}`, now, day, CODE_LIMITS.resendSec * 1000)
    .first();
  if (!gate) {
    await refundAll(env, caps);
    return none("resend_wait");
  }
  if (
    (await bump(env, `code:sentd:${ek}`, day)) ===
    CODE_LIMITS.sendsPerEmailPerDayAlert
  )
    logAuth({ evt: "code_abuse", scope: "send" });
  // The code a resend replaces (same pending request id), put back if this
  // send fails: the earlier email's code stays usable.
  const before = await stmt(
    env.DB,
    "select code_hash, expires_at, attempts, created_at from login_codes where email_key = ?1 and request_id = ?2",
  )
    .bind(ek, requestId)
    .first<CodeRow>();
  const code = await createCode(env, ek, requestId, now);
  const instance = (await getSettings(env).catch(() => null))?.name ?? null;
  const sent = await sendEmail(
    env,
    null,
    to,
    () =>
      loginCodeEmail({
        code,
        instance: instance ?? "Open Artifacts",
        appHost: env.APP_HOST,
        minutes: CODE_POLICY.ttlSec / 60,
      }),
    { kind: "code", now, caps: [], instance },
  );
  if (!sent) {
    // Only the row this call wrote (its hash): a racing resend's stays.
    const mine = await codeHash(env, ek, requestId, code);
    await (before
      ? stmt(
          env.DB,
          `update login_codes set code_hash = ?3, expires_at = ?4,
             attempts = ?5, created_at = ?6
           where email_key = ?1 and request_id = ?2 and code_hash = ?7`,
        ).bind(
          ek,
          requestId,
          before.code_hash,
          before.expires_at,
          before.attempts,
          before.created_at,
          mine,
        )
      : stmt(
          env.DB,
          "delete from login_codes where email_key = ?1 and request_id = ?2 and code_hash = ?3",
        ).bind(ek, requestId, mine)
    ).run();
    return none("send_failed");
  }
  logCodeSend("sent");
  // Test builds: the plaintext copy exists only once the email went out.
  if (noteOtp) await noteOtp(env, to, ek, "sent", code);
  return { requestId };
}

/**
 * Checks a code. Pinned order, the same statements whether or not a row
 * exists:
 * 1. Normalize: strip whitespace and hyphens; well-formed = exactly 8 digits.
 * 2. Reserve a per-IP failure slot atomically (none left: ipLocked).
 * 3. UPDATE … attempts = attempts + 1 WHERE … attempts < 5 AND unexpired
 *    RETURNING code_hash: atomic, so at most 5 guesses ever see the hash.
 * 4. HMAC the input and compare in constant time (against a dummy when no
 *    row came back, so the work is the same).
 * 5. One batch: consume the row (DELETE … AND code_hash = the compared hash;
 *    a guard, user input never meets code_hash in SQL) and refund the
 *    failure slot on success.
 * The result carries no reason, so an address that never got a code looks
 * like a wrong guess; the route words it from its signed cookie.
 */
export async function verifyCode(
  env: Env,
  _cfg: AuthConfig,
  p: {
    email: string;
    requestId: string;
    input: string;
    ip: string;
    now?: number;
  },
): Promise<{ ok: true } | { ok: false } | { ok: false; ipLocked: number }> {
  const now = p.now ?? Date.now();
  const norm = p.input.replace(/[\s-]/g, "");
  const wellFormed = /^[0-9]{8}$/.test(norm);
  const ek = await emailKey(env, p.email);
  const ik = await ipKey(env, p.ip);
  const failKey = `code:fail:${ik}`;
  const hour = counterBucket("hour", now);

  const refused = await takeAll(env, [
    [failKey, CODE_LIMITS.failsPerIpPerHour, hour],
  ]);
  if (refused !== -1) return { ok: false, ipLocked: retryAfter("hour", now) };

  const row = await stmt(
    env.DB,
    `update login_codes set attempts = attempts + 1
     where email_key = ?1 and request_id = ?2 and attempts < ?3 and expires_at > ?4
     returning code_hash`,
  )
    .bind(ek, p.requestId, CODE_POLICY.maxAttempts, now)
    .first<{ code_hash: string }>();

  const candidate = await codeHash(
    env,
    ek,
    p.requestId,
    wellFormed ? norm : "x",
  );
  const stored = row?.code_hash ?? DUMMY_HASH;
  const a = b64urlDecode(candidate) ?? new Uint8Array(32);
  const b = b64urlDecode(stored) ?? new Uint8Array(32);
  const same = sameBytes(a, b);
  const match = row !== null && wellFormed && same;

  const [del] = await env.DB.batch<{ x: number }>([
    stmt(
      env.DB,
      "delete from login_codes where email_key = ?1 and request_id = ?2 and code_hash = ?3 returning 1 as x",
    ).bind(ek, p.requestId, match ? stored : "!"),
    stmt(
      env.DB,
      "update counters set n = n - 1 where key = ?1 and day = ?2 and ?3 = 1 and n > 0",
    ).bind(failKey, hour, match ? 1 : 0),
  ]);
  return match && (del?.results.length ?? 0) > 0 ? { ok: true } : { ok: false };
}

/** Daily cron: drops expired sign-in codes (verify already refuses them). */
export async function sweepLoginCodes(env: Env, now = Date.now()) {
  await env.DB.prepare("delete from login_codes where expires_at < ?")
    .bind(now)
    .run();
}
