import { normalizeEmail } from "@oa/auth-core";
import {
  AUTH,
  CODE_POLICY,
  CodeRequestSchema,
  type CodeVerifyFailureDetails,
  CodeVerifySchema,
  type Member,
} from "@oa/shared";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { logAuth } from "../auth/audit.js";
import {
  codesKey,
  deliverCode,
  emailKey,
  takeRequestSlot,
  verifyCode,
} from "../auth/codes.js";
import { authConfig } from "../auth/config.js";
import { safeNext } from "../auth/oidc.js";
import { sessionCookie, signSession } from "../auth/session.js";
import { requireTurnstile } from "../auth/turnstile.js";
import { stmt } from "../db/stmt.js";
import { ApiError, appOrigin, errorJson } from "../http/errors.js";
import { type AppEnv, CSRF_HEADER, execCtx } from "../http/middleware.js";
import { signInAudit } from "../services/audit.js";
import { codeEligibility } from "../services/identity.js";
import { getUserWithEpoch, insertUser } from "../services/users.js";
import { forgetTestOtp } from "../test-hooks/index.js";
import {
  b64urlDecode,
  b64urlEncode,
  hmacSign,
  hmacVerify,
} from "../util/crypto.js";
import { utf8Decoder, utf8Encoder } from "../util/text.js";
import type { AppType } from "./index.js";

// Emailed-code sign-in (#359 AUTH.codeRequest / AUTH.codeVerify). JSON only;
// the SPA at SIGN_IN_PAGE owns the forms.

// `false` in release builds (build-flags.d.ts): no reference to test-hooks/.
const forgetOtp =
  typeof __OA_TEST_HOOKS_ALLOWED__ !== "undefined" &&
  __OA_TEST_HOOKS_ALLOWED__ === true &&
  forgetTestOtp;

const GUEST_MAX_AGE_S = 86_400;
const MAX_COOKIE_LEN = 1024;
/** A longer `next` becomes "/", so the pending cookie stays under MAX_COOKIE_LEN. */
const MAX_PENDING_NEXT = 512;

/**
 * The pending code, in this browser only: { ek, ee, rid, next, exp, f }.
 * `ee` is the address sealed (AES-GCM, oa:code-email key, `ek` as AAD), never
 * plaintext; the UI shows the 202's maskedEmail. `f` counts failed tries for
 * the 401 wording (the server-side limit is the row's attempts). Signed with
 * the code-cookie key (codesKey).
 */
type Pending = {
  ek: string;
  ee: string;
  rid: string;
  next: string;
  exp: number;
  f: number;
};

const aesKey = async (c: Context<AppEnv>) =>
  crypto.subtle.importKey(
    "raw",
    b64urlDecode(await codesKey(c.env, "oa:code-email")) ?? new Uint8Array(),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );

async function sealEmail(c: Context<AppEnv>, email: string, ek: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8Encoder.encode(ek) },
    await aesKey(c),
    utf8Encoder.encode(email),
  );
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return b64urlEncode(out);
}

async function openEmail(c: Context<AppEnv>, p: Pending) {
  const raw = b64urlDecode(p.ee);
  if (!raw || raw.length <= 12) return null;
  try {
    const pt = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: raw.slice(0, 12),
        additionalData: utf8Encoder.encode(p.ek),
      },
      await aesKey(c),
      raw.slice(12),
    );
    return utf8Decoder.decode(pt);
  } catch {
    return null;
  }
}

const cookieName = (c: Context<AppEnv>) =>
  c.env.ENVIRONMENT === "dev" ? "oa_code" : "__Host-oa_code";
const cookieAttrs = (c: Context<AppEnv>) =>
  c.env.ENVIRONMENT === "dev"
    ? "HttpOnly; SameSite=Lax; Path=/"
    : "HttpOnly; Secure; SameSite=Lax; Path=/";

async function pendingCookie(c: Context<AppEnv>, p: Pending): Promise<string> {
  const v = b64urlEncode(utf8Encoder.encode(JSON.stringify(p)));
  const sig = await hmacSign(await codesKey(c.env, "oa:code-cookie"), v);
  const maxAge = Math.max(0, Math.ceil((p.exp - Date.now()) / 1000));
  return `${cookieName(c)}=${v}.${sig}; ${cookieAttrs(c)}; Max-Age=${maxAge}`;
}
const clearPending = (c: Context<AppEnv>) =>
  `${cookieName(c)}=; ${cookieAttrs(c)}; Max-Age=0`;

async function readPending(c: Context<AppEnv>): Promise<Pending | null> {
  const raw = getCookie(c, cookieName(c));
  if (!raw || raw.length > MAX_COOKIE_LEN) return null;
  const [v, sig, extra] = raw.split(".");
  if (!v || !sig || extra !== undefined) return null;
  if (!(await hmacVerify(await codesKey(c.env, "oa:code-cookie"), v, sig)))
    return null;
  try {
    const bytes = b64urlDecode(v);
    if (!bytes) return null;
    const p = JSON.parse(utf8Decoder.decode(bytes)) as Partial<Pending>;
    if (
      typeof p.ek !== "string" ||
      typeof p.ee !== "string" ||
      typeof p.rid !== "string" ||
      typeof p.next !== "string" ||
      typeof p.exp !== "number" ||
      typeof p.f !== "number"
    )
      return null;
    return p as Pending;
  } catch {
    return null;
  }
}

/**
 * Login POSTs carry no session, so the usual CSRF rule (cookie-authenticated
 * mutations) doesn't cover them: require X-OA-Request: 1, a JSON body, and
 * Sec-Fetch-Site: same-origin (or, without it, an exact Origin).
 */
function guard(c: Context<AppEnv>): void {
  const site = c.req.header("sec-fetch-site");
  const origin = c.req.header("origin");
  const sameOrigin = site
    ? site === "same-origin"
    : origin === appOrigin(c.env);
  const json = (c.req.header("content-type") ?? "")
    .toLowerCase()
    .startsWith("application/json");
  if (!sameOrigin || c.req.header(CSRF_HEADER) !== "1" || !json)
    throw new ApiError("csrf", "Cross-site or malformed sign-in request");
}

/** Codes are a sign-in method only where `email` is enabled. */
function requireCodes(c: Context<AppEnv>) {
  const cfg = authConfig(c.env);
  if (!cfg.providers.has("email")) throw new ApiError("not_found", "Not found");
  return cfg;
}

const clientIp = (c: Context<AppEnv>) =>
  c.req.header("cf-connecting-ip") ?? "0.0.0.0";

const rateLimited = (retryAfter: number, scope: "ip" | "email") =>
  errorJson(
    429,
    "rate_limited",
    "Too many attempts; try again later",
    { retryAfter, scope },
    { "retry-after": String(retryAfter) },
  );

const unauthorized = (details: CodeVerifyFailureDetails, cookies: string[]) => {
  logAuth({ provider: "code", outcome: "refused", stage: details.reason });
  const res = errorJson(401, "unauthorized", "Sign-in failed", details);
  for (const k of cookies) res.headers.append("set-cookie", k);
  return res;
};

/** "b***@acme.com": the first character of the local part, then the domain. */
const mask = (email: string) => {
  const at = email.lastIndexOf("@");
  return `${email.slice(0, 1)}***${email.slice(at)}`;
};

/** RL_AUTH per install and IP; outside dev, unbound is 503 code_unavailable. */
async function authLimit(c: Context<AppEnv>, installKey: string, ip: string) {
  const rl = c.env.RL_AUTH;
  if (!rl) {
    if (c.env.ENVIRONMENT === "dev") return true;
    throw new ApiError(
      "code_unavailable",
      "Code sign-in is unavailable on this install",
    );
  }
  return (await rl.limit({ key: `${installKey}:${ip}` })).success;
}

/** Creates the user a verified code admits, when there's no row yet. */
async function ensureUser(
  c: Context<AppEnv>,
  email: string,
  role: "member" | "guest",
): Promise<string | null> {
  const now = Date.now();
  await insertUser(c.env, {
    email,
    name: email.slice(0, email.lastIndexOf("@")) || email,
    role,
    createdAt: now,
    lastSeenAt: now,
  }).onConflictDoNothing();
  const row = await stmt(
    c.env.DB,
    "select id from users where email = ?1 and status = 'active'",
  )
    .bind(email)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export function mountCodes(app: AppType): void {
  app.post(AUTH.codeRequest, async (c) => {
    guard(c);
    const cfg = requireCodes(c);
    const parsed = CodeRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    const email = parsed.success ? normalizeEmail(parsed.data.email) : null;
    if (!parsed.success || !email)
      throw new ApiError("bad_request", "Invalid email", { field: "email" });
    const ip = clientIp(c);
    // Turnstile is the bound on distributed attackers (the per-network caps
    // can't stop many networks), so hosted installs never run codes without it.
    // Self-hosted installs without Turnstile are weaker (docs/self-hosting).
    if (c.env.HOSTED === "1" && !cfg.turnstile)
      throw new ApiError("code_unavailable", "Sign-in by code is unavailable");
    await requireTurnstile(
      cfg,
      parsed.data.turnstileToken,
      ip,
      c.env.APP_HOST ?? new URL(c.req.url).hostname,
      c.env,
    );
    if (!(await authLimit(c, cfg.installKey, ip))) return rateLimited(60, "ip");
    const ek = await emailKey(c.env, email);
    const slot = await takeRequestSlot(c.env, cfg, ek, ip);
    if (!slot.ok) return rateLimited(slot.retryAfter, slot.scope);

    const rid = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    const next = safeNext(c.env, parsed.data.next);
    const pending: Pending = {
      ek,
      ee: await sealEmail(c, email, ek),
      rid,
      next: next.length > MAX_PENDING_NEXT ? "/" : next,
      exp: Date.now() + CODE_POLICY.ttlSec * 1000,
      f: 0,
    };
    // Eligibility, the row and the email happen after the response, so its
    // timing says nothing about the address.
    const work = deliverCode(c.env, cfg, email, ek, rid, ip).catch(() => null);
    const ctx = execCtx(c);
    if (ctx) ctx.waitUntil(work);
    else await work;
    const res = c.json(
      {
        maskedEmail: mask(email),
        expiresIn: CODE_POLICY.ttlSec,
        resendAfter: CODE_POLICY.resendAfterSec,
        codeLength: CODE_POLICY.length,
      },
      202,
    );
    res.headers.append("set-cookie", await pendingCookie(c, pending));
    res.headers.set("cache-control", "no-store");
    return res;
  });

  app.post(AUTH.codeVerify, async (c) => {
    guard(c);
    const cfg = requireCodes(c);
    // Before any D1 work (the pending check reads the code-cookie key).
    if (!(await authLimit(c, cfg.installKey, clientIp(c))))
      return rateLimited(60, "ip");
    const parsed = CodeVerifySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      throw new ApiError("bad_request", "Invalid request body");
    const p = await readPending(c);
    const email = p ? await openEmail(c, p) : null;
    if (!p || !email || p.ek !== (await emailKey(c.env, email)))
      return unauthorized({ reason: "no_pending" }, [clearPending(c)]);
    if (Date.now() > p.exp)
      return unauthorized({ reason: "expired" }, [clearPending(c)]);

    const r = await verifyCode(c.env, cfg, {
      email,
      requestId: p.rid,
      input: parsed.data.code,
      ip: clientIp(c),
    });
    if ("ipLocked" in r) {
      logAuth({ provider: "code", outcome: "refused", stage: "ip_locked" });
      return rateLimited(r.ipLocked, "ip");
    }
    const first = r.ok ? await codeEligibility(c.env, cfg, email) : null;
    // A new address gets its row now; role and link are then read again, so
    // a row that a concurrent sign-in or invite created is what's checked.
    const elig =
      first && first.kind !== "none" && first.userId === null
        ? (await ensureUser(
            c,
            email,
            first.kind === "guest" ? "guest" : "member",
          )) && (await codeEligibility(c.env, cfg, email))
        : first;
    if (!r.ok || !elig || elig.kind === "none") {
      const f = p.f + 1;
      const left = Math.max(0, CODE_POLICY.maxAttempts - f);
      if (r.ok || left === 0)
        return unauthorized({ reason: "expired" }, [clearPending(c)]);
      return unauthorized({ reason: "invalid_code", attemptsLeft: left }, [
        await pendingCookie(c, { ...p, f }),
      ]);
    }

    const row = elig.userId ? await getUserWithEpoch(c.env, elig.userId) : null;
    if (!row) return unauthorized({ reason: "expired" }, [clearPending(c)]);
    const user: Member = row.user;
    const guest = elig.kind === "guest";
    const domain = email.slice(email.lastIndexOf("@") + 1);
    const maxAgeS = guest ? GUEST_MAX_AGE_S : undefined;
    const sess = await signSession(c.env, user.id, Date.now(), {
      provider: "code",
      tenant: guest ? undefined : domain,
      epoch: row.sessionEpoch,
      maxAgeS,
    });
    // The sign-in and its auth.signin audit row commit together.
    await c.env.DB.batch([
      stmt(c.env.DB, "update users set last_seen_at = ?1 where id = ?2").bind(
        Date.now(),
        user.id,
      ),
      signInAudit(c.env, user.id, "code", guest ? undefined : domain),
    ]);
    logAuth({
      provider: "code",
      outcome: "ok",
      uid: user.id,
      tenant: guest ? undefined : domain,
    });
    const res = c.json({
      next: p.next,
      user,
      readOnly: guest,
    });
    res.headers.append("set-cookie", clearPending(c));
    if (forgetOtp) await forgetOtp(c.env, p.ek);
    res.headers.append("set-cookie", sessionCookie(sess, c.env, maxAgeS));
    res.headers.set("cache-control", "no-store");
    return res;
  });
}
