import type { Env } from "../env.js";
import { ApiError, appOrigin } from "../http/errors.js";
import {
  b64urlDecode,
  b64urlEncode,
  hmacSign,
  hmacVerify,
} from "../util/crypto.js";
import { logAuth } from "./audit.js";
import type { ProviderId } from "./config.js";
import { cookieKeys, LEGACY_KEY_UNTIL } from "./keys.js";
import type { OidcProvider, VerifiedIdentity } from "./providers/types.js";

export { accessIssuer } from "./providers/access.js";

/*
 * OIDC login state.
 *
 * Each login attempt gets its own signed cookie `__Host-oa_oidc_<k>` (dev over
 * http: plain `oa_oidc_<k>`, Path=/auth), where k = first 10 base64url chars of
 * sha256(state). The callback recomputes k from the `state` query param to pick
 * the cookie, then still verifies the HMAC and compares state in constant time.
 * Parallel tabs therefore don't clobber each other, and at most MAX_ATTEMPTS
 * cookies are kept (oldest by signed exp evicted at login; unparseable first).
 *
 * Security (login CSRF / cookie tossing): a callback is accepted only if its
 * `state` equals the state inside an HMAC-signed cookie this browser presents.
 * The HMAC alone does not bind the cookie to a browser: an attacker can run
 * /auth/login themselves and obtain a perfectly valid (state, cookie) pair. What
 * stops them is that they cannot make the victim's browser *hold* that cookie.
 * A sibling or parent-domain host they control (e.g. another *.example.com
 * app, or the content host) could otherwise set `Domain=.example.com` cookies
 * that the app host receives. The `__Host-` prefix forbids exactly that: the
 * browser only stores a `__Host-` cookie if it is set by this exact host with
 * `Secure`, `Path=/` and no `Domain` attribute, so no other host can plant or
 * overwrite one. Hence the prefixed name is the only one read in production,
 * and the legacy un-prefixed `oa_oidc` cookie is no longer accepted at all.
 * k is a public hash prefix, not a secret; nothing is accepted on k alone.
 *
 * The payload names its provider (`p`); a callback for another provider is a
 * state mismatch, so one flow's state can never be redeemed by another (mix-up).
 * State cookies are signed with deriveKey("oa:oidc-state"); cookies signed with the
 * raw SESSION_SECRET (before P2) are still read until LEGACY_KEY_UNTIL.
 *
 * State failures (missing / bad sig / expired / mismatch) redirect once to
 * /auth/login?retry=1. The retry flag rides in the signed payload and as a
 * public `r1.` prefix on `state` (so it survives even if the cookie never comes
 * back); a second state failure renders a static page instead: no loop.
 */
const OIDC_BASE = "oa_oidc_";
const hostPrefixed = (env: Env) => env.ENVIRONMENT !== "dev";
const oidcPrefix = (env: Env) =>
  hostPrefixed(env) ? `__Host-${OIDC_BASE}` : OIDC_BASE;
const oidcNameRe = (env: Env) =>
  hostPrefixed(env)
    ? /^__Host-oa_oidc_[A-Za-z0-9_-]{10}$/
    : /^oa_oidc_[A-Za-z0-9_-]{10}$/;
/** Browsers silently drop cookies over ~4096 bytes; stay well under. */
const MAX_SET_COOKIE_LEN = 3800;
const OIDC_MAX_AGE_S = 900;
const MAX_ATTEMPTS = 3;
const MAX_SCANNED = 16;
const RETRY_MARK = "r1.";
const MAX_NEXT_LEN = 2048;
const MAX_COOKIE_LEN = 4096;

export { LEGACY_KEY_UNTIL };

type OidcState = {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  exp: number;
  retry?: boolean;
  /** Provider; absent (cookies from before P2) reads as "access". */
  p?: ProviderId;
  /** A forced re-authentication was asked for (break-glass, P3 T18). */
  ra?: true;
};

type StateKeys = { key: string; legacy: string | null };

/** The state-cookie key, plus the legacy raw secret while it is still accepted. */
async function stateKeys(env: Env): Promise<StateKeys> {
  return cookieKeys(env, "oa:oidc-state");
}

const unsafePrefix = (p: string) =>
  !p.startsWith("/") || p.startsWith("//") || p.startsWith("/\\");

/**
 * Same-origin path or "/". The normalized output is re-checked (dot segments and
 * backslashes can resolve to "//host"), and the cap applies to the serialized,
 * percent-encoded form so the oa_oidc cookie stays small.
 */
export function safeNext(env: Env, next: string | undefined | null): string {
  if (typeof next !== "string" || next.length > MAX_NEXT_LEN) return "/";
  if (unsafePrefix(next)) return "/";
  const origin = appOrigin(env);
  try {
    const u = new URL(next, origin);
    if (u.origin !== origin) return "/";
    const out = `${u.pathname}${u.search}${u.hash}`;
    if (out.length > MAX_NEXT_LEN || unsafePrefix(out)) return "/";
    return out;
  } catch {
    return "/";
  }
}

const randomB64 = (n: number) =>
  b64urlEncode(crypto.getRandomValues(new Uint8Array(n)));

async function s256(v: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return b64urlEncode(new Uint8Array(d));
}

function oidcCookie(
  env: Env,
  name: string,
  value: string,
  maxAge: number,
): string {
  // __Host- requires Secure, Path=/ and no Domain.
  const attrs = hostPrefixed(env)
    ? "HttpOnly; Secure; SameSite=Lax; Path=/"
    : "HttpOnly; SameSite=Lax; Path=/auth";
  return `${name}=${value}; ${attrs}; Max-Age=${maxAge}`;
}

export const clearOidcCookie = (env: Env, name: string) =>
  oidcCookie(env, name, "", 0);

/** Per-attempt cookie name for a state value. */
export async function stateCookieName(
  env: Env,
  state: string,
): Promise<string> {
  return `${oidcPrefix(env)}${(await s256(state)).slice(0, 10)}`;
}

function parseCookies(header: string | null | undefined): [string, string][] {
  const out: [string, string][] = [];
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out.push([part.slice(0, i).trim(), part.slice(i + 1).trim()]);
  }
  return out;
}

/** Set-Cookie clears for the oldest attempts so that, with the new one, at most MAX_ATTEMPTS remain. */
async function evictions(
  env: Env,
  keys: StateKeys,
  cookieHeader: string | null | undefined,
): Promise<string[]> {
  const seen = new Map<string, string>();
  for (const [n, v] of parseCookies(cookieHeader))
    if (oidcNameRe(env).test(n) && !seen.has(n)) seen.set(n, v);
  const excess = seen.size - (MAX_ATTEMPTS - 1);
  if (excess <= 0) return [];
  const ranked: { name: string; exp: number }[] = [];
  let scanned = 0;
  for (const [name, value] of seen) {
    // Bound HMAC work; anything past the cap is treated as unparseable.
    const r = scanned++ < MAX_SCANNED ? await readOidcState(keys, value) : null;
    ranked.push({ name, exp: r?.st ? r.st.exp : Number.NEGATIVE_INFINITY });
  }
  ranked.sort((a, b) => a.exp - b.exp);
  return ranked.slice(0, excess).map((x) => clearOidcCookie(env, x.name));
}

export async function buildAuthorizeRedirect(
  env: Env,
  provider: OidcProvider,
  next: string,
  opts: {
    retry?: boolean;
    cookieHeader?: string | null;
    /** Ask the provider to re-authenticate (P3 T18 break-glass). */
    reauth?: boolean;
  } = {},
): Promise<{ location: string; stateCookie: string; evict: string[] }> {
  const keys = await stateKeys(env);
  const retry = opts.retry === true;
  const reauth = opts.reauth === true;
  const st: OidcState = {
    state: `${retry ? RETRY_MARK : ""}${randomB64(32)}`,
    nonce: randomB64(32),
    verifier: randomB64(32),
    next: safeNext(env, next),
    exp: Date.now() + OIDC_MAX_AGE_S * 1000,
    ...(retry ? { retry: true } : {}),
    p: provider.id,
    ...(reauth ? { ra: true as const } : {}),
  };
  const name = await stateCookieName(env, st.state);
  const sign = async () => {
    const p = b64urlEncode(new TextEncoder().encode(JSON.stringify(st)));
    return oidcCookie(
      env,
      name,
      `${p}.${await hmacSign(keys.key, p)}`,
      OIDC_MAX_AGE_S,
    );
  };
  // Measure the final Set-Cookie (JSON escaping can inflate `next`, e.g.
  // backslashes); if it would be dropped by the browser, fall back to "/".
  let stateCookie = await sign();
  if (stateCookie.length > MAX_SET_COOKIE_LEN) {
    st.next = "/";
    stateCookie = await sign();
  }
  return {
    location: await provider.authorizeUrl(env, {
      state: st.state,
      nonce: st.nonce,
      challenge: await s256(st.verifier),
      ...(reauth ? { reauth } : {}),
    }),
    stateCookie,
    evict: await evictions(env, keys, opts.cookieHeader),
  };
}

export const tag = (v: unknown) =>
  typeof v === "string"
    ? v
        .toLowerCase()
        .replace(/[^a-z_]/g, "")
        .slice(0, 64)
    : undefined;

/**
 * Structured failure log. Callers pass only a fixed stage and sanitized
 * enum-like extras: never tokens, codes, emails, state values or secrets.
 */
export function logOidcFail(
  stage: string,
  extra: Record<string, string | undefined> = {},
): void {
  logAuth({ ...extra, evt: "oidc_fail", stage });
}

/** State-cookie failure: the route redirects to a retry login (or the static page). */
export class OidcStateError extends ApiError {
  constructor(
    public next: string,
    public retry: boolean,
    /** The logged state stage ("no_state_cookie", "state_expired", …). */
    public stage: string = "state",
  ) {
    super("unauthorized", "Login failed");
  }
}

/**
 * A refusal after the state cookie checked out: the route knows where the
 * user was going (`next`) and can send them back to the sign-in page.
 */
export class OidcRedeemError extends ApiError {
  constructor(
    public next: string,
    /** The logged failure stage ("tenant", "jwt_verify", …), when known. */
    public stage: string | null,
  ) {
    super("unauthorized", "Login failed");
  }
}

/** ApiError("unauthorized") that remembers its (already logged) stage. */
class OidcFailure extends ApiError {
  constructor(public stage: string) {
    super("unauthorized", "Login failed");
  }
}

export const fail = (
  stage: string,
  extra?: Record<string, string | undefined>,
): never => {
  logOidcFail(stage, extra);
  throw new OidcFailure(stage);
};

/** The cookie for this attempt (by state), else null. No legacy fallback. */
export async function pickStateCookie(
  env: Env,
  req: Request,
  state: string,
): Promise<{ name: string; value: string } | null> {
  const name = await stateCookieName(env, state);
  const hit = parseCookies(req.headers.get("cookie")).find(([n]) => n === name);
  return hit ? { name, value: hit[1] } : null;
}

type StateRead =
  | { stage: null; st: OidcState }
  | { stage: "state_expired"; st: OidcState }
  | { stage: "state_bad_sig"; st?: undefined };

/** HMAC-verified payload; expired payloads are returned (for `next`/`retry`) but flagged. */
async function readOidcState(
  keys: StateKeys,
  value: string,
): Promise<StateRead> {
  const bad = { stage: "state_bad_sig" } as const;
  if (value.length > MAX_COOKIE_LEN) return bad;
  const parts = value.split(".");
  if (parts.length !== 2) return bad;
  const [p, sig] = parts as [string, string];
  if (
    !(await hmacVerify(keys.key, p, sig)) &&
    !(keys.legacy !== null && (await hmacVerify(keys.legacy, p, sig)))
  )
    return bad;
  const raw = b64urlDecode(p);
  if (!raw) return bad;
  try {
    const o = JSON.parse(new TextDecoder().decode(raw)) as Partial<OidcState>;
    if (
      !o ||
      typeof o.state !== "string" ||
      typeof o.nonce !== "string" ||
      typeof o.verifier !== "string" ||
      typeof o.next !== "string" ||
      typeof o.exp !== "number" ||
      !Number.isFinite(o.exp) ||
      (o.p !== undefined && o.p !== "access" && o.p !== "google")
    )
      return bad;
    const st = o as OidcState;
    return st.exp <= Date.now()
      ? { stage: "state_expired", st }
      : { stage: null, st };
  } catch {
    return bad;
  }
}

/** KV prefix for consumed OIDC states (the HMAC of the nonce, never the nonce). */
const USED_STATE = "oidc_used:";
/** KV's minimum expirationTtl. */
const KV_MIN_TTL_S = 60;

/**
 * Single use server-side: the browser clears the state cookie, but a captured
 * cookie plus a fresh code must not sign in again. Marks this state consumed
 * in OAUTH_KV until it expires; a second use fails (stage state_replay).
 * Best effort against two concurrent uses (KV has no compare-and-set); the
 * IdP's single-use code and the nonce still bind each sign-in.
 */
async function consumeState(
  env: Env,
  key: string,
  st: OidcState,
): Promise<void> {
  const id = USED_STATE + (await hmacSign(key, `used:${st.nonce}`));
  if ((await env.OAUTH_KV.get(id)) !== null) fail("state_replay");
  const ttl = Math.max(KV_MIN_TTL_S, Math.ceil((st.exp - Date.now()) / 1000));
  await env.OAUTH_KV.put(id, "1", { expirationTtl: ttl });
}

/** Constant-time string equality via HMAC verify. */
export async function safeEqual(secret: string, a: string, b: string) {
  return hmacVerify(secret, a, await hmacSign(secret, b));
}

/**
 * Validates this browser's state cookie for `provider`, then lets the provider
 * redeem the code. Throws OidcStateError on state failures (the route retries
 * once) and ApiError("unauthorized") on everything else; never leaks detail.
 */
export async function handleCallback(
  env: Env,
  provider: OidcProvider,
  req: Request,
): Promise<VerifiedIdentity & { next: string; reauth: boolean }> {
  const keys = await stateKeys(env);
  const q = new URL(req.url).searchParams;
  const state = q.get("state") ?? "";
  const failState = (stage: string, from?: OidcState): never => {
    logOidcFail(stage);
    // `next` only from an HMAC-valid payload; retry from it or the public marker.
    throw new OidcStateError(
      safeNext(env, from?.next ?? "/"),
      from?.retry === true || state.startsWith(RETRY_MARK),
      stage,
    );
  };
  const picked = await pickStateCookie(env, req, state);
  if (!picked) return failState("no_state_cookie");
  const read = await readOidcState(keys, picked.value);
  if (read.stage === "state_bad_sig") return failState("state_bad_sig");
  if (read.stage === "state_expired")
    return failState("state_expired", read.st);
  const st = read.st;
  if (!(await safeEqual(keys.key, state, st.state)))
    return failState("state_mismatch");
  // Mix-up: a state minted for one provider is never redeemed by another.
  if ((st.p ?? "access") !== provider.id) return failState("state_mismatch");
  const next = safeNext(env, st.next);
  try {
    await consumeState(env, keys.key, st);
    if (q.has("error"))
      return fail("idp_error", { error: tag(q.get("error")) });
    const code = q.get("code");
    if (!code) return fail("no_code");
    const id = await provider.redeem(env, {
      code,
      verifier: st.verifier,
      nonce: st.nonce,
      bstate: q.get("bstate") ?? undefined,
    });
    return { ...id, next, reauth: st.ra === true };
  } catch (e) {
    if (e instanceof ApiError)
      throw new OidcRedeemError(
        next,
        e instanceof OidcFailure ? e.stage : null,
      );
    throw e;
  }
}
