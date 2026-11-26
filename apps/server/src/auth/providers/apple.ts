import { normalizeEmail } from "@oa/auth-core";
import { AUTH } from "@oa/shared";
import {
  createRemoteJWKSet,
  importPKCS8,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
  SignJWT,
} from "jose";
import type { Env } from "../../env.js";
import { ApiError, appOrigin } from "../../http/errors.js";
import { authConfig } from "../config.js";
import { fail } from "../oidc.js";
import type { OidcProvider, VerifiedIdentity } from "./types.js";

// Sign in with Apple (self-hosted direct transport only, #3087 slice 4).
// Apple uses response_mode=form_post for the callback (a cross-site POST with
// code, state, and a first-sign-in-only `user` JSON payload). Apple does not
// support PKCE on its authorization/token endpoints, so this flow relies on
// the HMAC-signed SameSite=None state cookie (path-scoped to callbackApple)
// plus the ID token `nonce` claim and a short-lived ES256 client_secret JWT.

export const APPLE_AUTHORIZE_URL = "https://appleid.apple.com/auth/authorize";
export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
export const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
export const APPLE_ISSUER = "https://appleid.apple.com";

const CLIENT_SECRET_TTL_S = 300;
const CLOCK_TOLERANCE_S = 60;
const MAX_TOKEN_AGE = "1h";
const MAX_NAME = 200;
const PRIVATE_RELAY_SUFFIX = "@privaterelay.appleid.com";

const enc = new TextEncoder();

let appleJwks: JWTVerifyGetKey | undefined;

const redirectUri = (env: Env) => `${appOrigin(env)}${AUTH.callbackApple}`;

/** The Apple config, or 404 (sign-in not offered). */
function appleConfig(env: Env) {
  const cfg = authConfig(env);
  if (!cfg.apple) throw new ApiError("not_found", "Not found");
  return cfg.apple;
}

/** Constant-time string equality via SHA-256 digests. */
async function sameString(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const u = new Uint8Array(x);
  const v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++)
    diff |= (u[i] as number) ^ (v[i] as number);
  return diff === 0;
}

/**
 * Signs Apple's ES256 client_secret JWT (iss = Team ID, sub = Services ID,
 * aud = https://appleid.apple.com, kid = Key ID, exp = now + 5 min).
 */
async function signClientSecret(cfg: {
  servicesId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
}): Promise<string> {
  const key = await importPKCS8(cfg.privateKey, "ES256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: cfg.keyId })
    .setIssuer(cfg.teamId)
    .setIssuedAt(now)
    .setExpirationTime(now + CLIENT_SECRET_TTL_S)
    .setAudience(APPLE_ISSUER)
    .setSubject(cfg.servicesId)
    .sign(key);
}

/**
 * Extracts a display name from Apple's first-sign-in-only `user` JSON form
 * field (`{"name":{"firstName":"...","lastName":"..."},"email":"..."}`).
 * Never throws: absent or malformed JSON returns null.
 */
function parseAppleUserName(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      name?: { firstName?: unknown; lastName?: unknown };
    } | null;
    const first =
      typeof parsed?.name?.firstName === "string"
        ? parsed.name.firstName.trim()
        : "";
    const last =
      typeof parsed?.name?.lastName === "string"
        ? parsed.name.lastName.trim()
        : "";
    const combined = [first, last].filter(Boolean).join(" ").trim();
    return combined ? combined.slice(0, MAX_NAME) : null;
  } catch {
    return null;
  }
}

async function exchange(
  env: Env,
  cfg: {
    servicesId: string;
    teamId: string;
    keyId: string;
    privateKey: string;
  },
  code: string,
): Promise<string> {
  let clientSecret: string;
  try {
    clientSecret = await signClientSecret(cfg);
  } catch {
    return fail("client_secret");
  }
  const res = await fetch(APPLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(env),
      client_id: cfg.servicesId,
      client_secret: clientSecret,
    }),
    redirect: "manual",
  });
  if (!res.ok) {
    await res.body?.cancel();
    return fail(`token_http_${res.status}`);
  }
  let out: unknown;
  try {
    out = await res.json();
  } catch {
    return fail("token_bad_json");
  }
  const idToken = (out as { id_token?: unknown } | null)?.id_token;
  return typeof idToken === "string" ? idToken : fail("no_id_token");
}

export const appleProvider: OidcProvider = {
  id: "apple",
  callbackPath: AUTH.callbackApple,
  formPost: true,

  authorizeUrl(env, a) {
    const cfg = appleConfig(env);
    const u = new URL(APPLE_AUTHORIZE_URL);
    // Apple Sign In does not support PKCE (code_challenge); we rely on
    // state (bound to the SameSite=None HMAC-signed state cookie) + nonce
    // (verified inside the signed id_token) + ES256 client_secret.
    u.search = new URLSearchParams({
      client_id: cfg.servicesId,
      redirect_uri: redirectUri(env),
      response_type: "code",
      response_mode: "form_post",
      scope: "name email",
      state: a.state,
      nonce: a.nonce,
    }).toString();
    return u.toString();
  },

  async redeem(env, a): Promise<VerifiedIdentity> {
    const cfg = appleConfig(env);
    let idToken: string;
    try {
      idToken = await exchange(env, cfg, a.code);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      return fail("token_fetch");
    }
    let claims: JWTPayload & Record<string, unknown>;
    try {
      appleJwks ??= createRemoteJWKSet(new URL(APPLE_JWKS_URL));
      ({ payload: claims } = await jwtVerify(idToken, appleJwks, {
        algorithms: ["RS256", "ES256"],
        issuer: APPLE_ISSUER,
        audience: cfg.servicesId,
        clockTolerance: CLOCK_TOLERANCE_S,
        maxTokenAge: MAX_TOKEN_AGE,
        requiredClaims: ["sub", "exp", "iat", "nonce"],
      }));
    } catch {
      return fail("jwt_verify");
    }
    const aud = claims.aud;
    if (
      !(
        aud === cfg.servicesId ||
        (Array.isArray(aud) && aud.length === 1 && aud[0] === cfg.servicesId)
      )
    )
      return fail("aud");
    if (
      typeof claims.nonce !== "string" ||
      !(await sameString(claims.nonce, a.nonce))
    )
      return fail("nonce");
    const sub = claims.sub;
    const email =
      typeof claims.email === "string" ? normalizeEmail(claims.email) : null;
    if (typeof sub !== "string" || !sub || !email) return fail("claims");
    const isPrivateRelay =
      claims.is_private_email === true ||
      claims.is_private_email === "true" ||
      email.endsWith(PRIVATE_RELAY_SUFFIX);
    // TODO(#3087 slice 4b): a private relay address never matches an invited
    // row, so admit() returns no_access for an unlinked relay user; the
    // "confirm your real address" step lands in slice 4b.
    const emailVerified =
      (claims.email_verified === true || claims.email_verified === "true") &&
      !isPrivateRelay;
    return {
      provider: "apple",
      subject: sub,
      email,
      emailVerified,
      name: parseAppleUserName(a.user),
      tenant: null,
    };
  },
};
