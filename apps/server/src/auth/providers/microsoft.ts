import { normalizeEmail } from "@oa/auth-core";
import { AUTH } from "@oa/shared";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import type { Env } from "../../env.js";
import { ApiError, appOrigin } from "../../http/errors.js";
import { authConfig } from "../config.js";
import { cookieKeys } from "../keys.js";
import { fail, safeEqual } from "../oidc.js";
import type { OidcProvider, VerifiedIdentity } from "./types.js";

// Sign in with Microsoft (self-hosted direct transport, #3087 slice 2).
// Uses the multi-tenant `common` endpoint and verifies the ID token locally:
// RS256 signature against Microsoft's JWKS, aud = client id, exp/nbf skew,
// constant-time nonce, and per-tenant issuer `https://login.microsoftonline.com/{tid}/v2.0`.
// Subject is `${tid}:${oid}` (never `sub` alone). Microsoft does not vouch for
// email addresses across tenants/personal accounts, so emailVerified is always
// false and admit() requires an emailed code on first link.

export const MICROSOFT_AUTHORIZE_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
export const MICROSOFT_TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";
export const MICROSOFT_JWKS_URL =
  "https://login.microsoftonline.com/common/discovery/v2.0/keys";

const CLOCK_TOLERANCE_S = 60;
const MAX_NAME = 200;
const SAFE_TID = /^[A-Za-z0-9-]+$/;

const redirectUri = (env: Env) => `${appOrigin(env)}${AUTH.callbackMicrosoft}`;

/** The Microsoft config, or 404 (sign-in not offered). */
function microsoftConfig(env: Env) {
  const m = authConfig(env).microsoft;
  if (!m) throw new ApiError("not_found", "Not found");
  return m;
}

let microsoftJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
function jwks() {
  microsoftJwks ??= createRemoteJWKSet(new URL(MICROSOFT_JWKS_URL));
  return microsoftJwks;
}

async function exchange(
  env: Env,
  clientId: string,
  secret: string,
  a: { code: string; verifier: string },
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(MICROSOFT_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: a.code,
        redirect_uri: redirectUri(env),
        client_id: clientId,
        client_secret: secret,
        code_verifier: a.verifier,
      }),
      redirect: "manual",
    });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return fail("token_fetch");
  }
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

export const microsoftProvider: OidcProvider = {
  id: "microsoft",
  callbackPath: AUTH.callbackMicrosoft,

  authorizeUrl(env, a) {
    const m = microsoftConfig(env);
    const u = new URL(MICROSOFT_AUTHORIZE_URL);
    u.search = new URLSearchParams({
      client_id: m.clientId,
      response_type: "code",
      redirect_uri: redirectUri(env),
      scope: "openid email profile",
      state: a.state,
      nonce: a.nonce,
      code_challenge: a.challenge,
      code_challenge_method: "S256",
      response_mode: "query",
      ...(a.reauth ? { max_age: "0" } : {}),
    }).toString();
    return u.toString();
  },

  async redeem(env, a): Promise<VerifiedIdentity> {
    const m = microsoftConfig(env);
    const idToken = await exchange(env, m.clientId, m.secret, a);

    let claims: JWTPayload & Record<string, unknown>;
    try {
      ({ payload: claims } = await jwtVerify(idToken, jwks(), {
        algorithms: ["RS256"],
        audience: m.clientId,
        clockTolerance: CLOCK_TOLERANCE_S,
        requiredClaims: ["iss", "exp", "nonce", "tid", "oid"],
      }));
    } catch {
      return fail("jwt_verify");
    }

    const aud = claims.aud;
    if (
      !(
        aud === m.clientId ||
        (Array.isArray(aud) && aud.length === 1 && aud[0] === m.clientId)
      )
    )
      return fail("aud");

    const tid = claims.tid;
    if (typeof tid !== "string" || !SAFE_TID.test(tid)) return fail("claims");
    if (claims.iss !== `https://login.microsoftonline.com/${tid}/v2.0`)
      return fail("jwt_verify");

    const oid = claims.oid;
    if (typeof oid !== "string" || !oid.trim()) return fail("claims");

    if (
      typeof claims.nonce !== "string" ||
      !(await safeEqual(
        (
          await cookieKeys(env, "oa:oidc-state")
        ).key,
        claims.nonce,
        a.nonce,
      ))
    )
      return fail("nonce");

    const email =
      (typeof claims.email === "string"
        ? normalizeEmail(claims.email)
        : null) ??
      (typeof claims.preferred_username === "string"
        ? normalizeEmail(claims.preferred_username)
        : null);
    if (!email) return fail("email");

    const name =
      typeof claims.name === "string" && claims.name.trim()
        ? claims.name.trim().slice(0, MAX_NAME)
        : null;

    return {
      provider: "microsoft",
      subject: `${tid}:${oid}`,
      email,
      // Microsoft does not vouch for email ownership across tenants/MSA.
      emailVerified: false,
      name,
      tenant: null,
    };
  },
};
