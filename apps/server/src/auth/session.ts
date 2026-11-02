import { isId, type SessionPayload } from "@oa/shared";
import type { Env } from "../env.js";
import {
  b64urlDecode,
  b64urlEncode,
  hmacSign,
  hmacVerify,
} from "../util/crypto.js";
import { utf8Decoder, utf8Encoder } from "../util/text.js";
import { cookieKeys } from "./keys.js";

/**
 * The __Host-oa_session payload (#359 SessionPayload): uid, exp, iat (ms),
 * p (how they signed in), t (verified tenant: Google hd, or the email domain
 * of a domain-code session), pd (a personal Google account's email domain),
 * e (users.session_epoch at issue). Signed with
 * deriveKey("oa:session"). Cookies from before P2 ({ uid, exp }, raw
 * SESSION_SECRET) read as p "access", e 0 until LEGACY_KEY_UNTIL.
 */
export type Session = SessionPayload;
export type SessionProvider = Session["p"];

export const MAX_AGE_S = 7 * 86400;
const MAX_COOKIE_LEN = 1024;
const PROVIDERS: readonly SessionProvider[] = [
  "access",
  "google",
  "code",
  "dev",
  "test",
];

export async function signSession(
  env: Env,
  uid: string,
  now = Date.now(),
  opts: {
    /** Required: a session that does not name its provider can't be audited. */
    provider: SessionProvider;
    /**
     * Required: the user's session_epoch at sign-in (users.session_epoch).
     * A default of 0 silently produced dead cookies after any epoch bump
     * (deactivation, role change, sync) and looped Access users on 401.
     */
    epoch: number;
    tenant?: string;
    /** A personal Google account's (no hd) email domain. */
    personalDomain?: string;
    maxAgeS?: number;
    /** Google auth_time (ms) of a forced re-authentication (P3 T18 break-glass). */
    authAt?: number;
  },
): Promise<string> {
  if (!isId(uid)) throw new Error("invalid uid");
  const { key } = await cookieKeys(env, "oa:session", now);
  const payload: Session = {
    uid,
    exp: now + (opts.maxAgeS ?? MAX_AGE_S) * 1000,
    iat: now,
    p: opts.provider,
    ...(opts.tenant ? { t: opts.tenant } : {}),
    ...(opts.personalDomain ? { pd: opts.personalDomain } : {}),
    e: opts.epoch,
    ...(opts.authAt !== undefined ? { a: opts.authAt } : {}),
  };
  const p = b64urlEncode(utf8Encoder.encode(JSON.stringify(payload)));
  return `${p}.${await hmacSign(key, p)}`;
}

async function verified(
  env: Env,
  p: string,
  sig: string,
  now: number,
): Promise<boolean> {
  const { key, legacy } = await cookieKeys(env, "oa:session", now);
  if (await hmacVerify(key, p, sig)) return true;
  return legacy !== null && hmacVerify(legacy, p, sig);
}

export async function readSession(
  env: Env,
  cookieValue: string | undefined,
  now = Date.now(),
): Promise<Session | null> {
  if (!cookieValue || cookieValue.length > MAX_COOKIE_LEN) return null;
  try {
    const parts = cookieValue.split(".");
    if (parts.length !== 2) return null;
    const [p, sig] = parts as [string, string];
    if (!(await verified(env, p, sig, now))) return null;
    const raw = b64urlDecode(p);
    if (!raw) return null;
    const s = JSON.parse(utf8Decoder.decode(raw)) as Partial<Session> | null;
    if (!s || typeof s.uid !== "string" || !isId(s.uid)) return null;
    if (typeof s.exp !== "number" || !Number.isFinite(s.exp) || s.exp <= now)
      return null;
    const prov = s.p ?? "access";
    if (!PROVIDERS.includes(prov)) return null;
    if (s.t !== undefined && typeof s.t !== "string") return null;
    if (s.pd !== undefined && typeof s.pd !== "string") return null;
    const e = s.e ?? 0;
    if (!Number.isSafeInteger(e) || e < 0) return null;
    const iat =
      typeof s.iat === "number" && Number.isFinite(s.iat)
        ? s.iat
        : s.exp - MAX_AGE_S * 1000;
    const a = typeof s.a === "number" && Number.isFinite(s.a) ? s.a : undefined;
    return {
      uid: s.uid,
      exp: s.exp,
      iat,
      p: prov,
      ...(s.t !== undefined ? { t: s.t } : {}),
      ...(s.pd !== undefined ? { pd: s.pd } : {}),
      e,
      ...(a !== undefined ? { a } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The session cookie name. Outside dev it is `__Host-` prefixed: browsers only
 * store such a cookie when this exact host sets it with Secure, Path=/ and no
 * Domain, so a sibling or parent-domain host cannot plant or overwrite a
 * session (cookie tossing / session fixation). Dev over http uses the plain
 * name. Every read, write and clear goes through this.
 */
export function sessionCookieName(env: Pick<Env, "ENVIRONMENT">): string {
  return env.ENVIRONMENT === "dev" ? "oa_session" : "__Host-oa_session";
}

const attrs = (env: Pick<Env, "ENVIRONMENT">) =>
  env.ENVIRONMENT === "dev"
    ? "HttpOnly; SameSite=Lax; Path=/"
    : "HttpOnly; Secure; SameSite=Lax; Path=/";

export function sessionCookie(
  value: string,
  env: Pick<Env, "ENVIRONMENT">,
  maxAgeS = MAX_AGE_S,
): string {
  return `${sessionCookieName(env)}=${value}; ${attrs(env)}; Max-Age=${maxAgeS}`;
}

export function clearSessionCookie(env: Pick<Env, "ENVIRONMENT">): string {
  return `${sessionCookieName(env)}=; ${attrs(env)}; Max-Age=0`;
}
