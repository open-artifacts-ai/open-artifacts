import { normalizeEmail } from "@oa/auth-core";
import { AUTH } from "@oa/shared";
import {
  decodeProtectedHeader,
  importJWK,
  type JWK,
  type JWTPayload,
  jwtVerify,
} from "jose";
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
// Issuer rules for the `common` JWKS (learn.microsoft.com/entra/identity-platform/
// access-tokens#validate-the-issuer): tid must be a GUID, and when the signing
// key (picked by kid) carries an `issuer`, that issuer with `{tenantid}` set to
// the token's tid must equal the token's iss. A key with no issuer has no
// tenant scope and is refused. The key's own alg/use/key_ops are honored.
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
const TID_GUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Asymmetric RSA signatures only: never "none" or HS*.
const RSA_SIG_ALGS = new Set([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
]);
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_REFETCH_COOLDOWN_MS = 30 * 1000;

const redirectUri = (env: Env) => `${appOrigin(env)}${AUTH.callbackMicrosoft}`;

/** The Microsoft config, or 404 (sign-in not offered). */
function microsoftConfig(env: Env) {
  const m = authConfig(env).microsoft;
  if (!m) throw new ApiError("not_found", "Not found");
  return m;
}

type MsJwk = JWK & { kid: string; issuer?: unknown };

// Microsoft's JWKS, cached per isolate. We hold the raw keys (not jose's
// remote set) so the key that verified a token, and its `issuer`, is known.
let jwksCache: { keys: MsJwk[]; at: number } | undefined;

async function fetchJwks(): Promise<MsJwk[]> {
  let res: Response;
  try {
    res = await fetch(MICROSOFT_JWKS_URL, {
      headers: { accept: "application/json" },
      redirect: "manual",
    });
  } catch {
    return fail("jwks_fetch");
  }
  if (!res.ok) {
    await res.body?.cancel();
    return fail(`jwks_http_${res.status}`);
  }
  let out: unknown;
  try {
    out = await res.json();
  } catch {
    return fail("jwks_bad_json");
  }
  const keys = (out as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) return fail("jwks_bad_json");
  return keys.filter(
    (k): k is MsJwk =>
      !!k && typeof k === "object" && typeof (k as MsJwk).kid === "string",
  );
}

/** The JWKS key with this kid, refetching once (rate-limited) on a miss. */
async function signingJwk(kid: string): Promise<MsJwk | undefined> {
  const now = Date.now();
  if (!jwksCache || now - jwksCache.at > JWKS_TTL_MS)
    jwksCache = { keys: await fetchJwks(), at: now };
  let k = jwksCache.keys.find((x) => x.kid === kid);
  if (!k && now - jwksCache.at > JWKS_REFETCH_COOLDOWN_MS) {
    jwksCache = { keys: await fetchJwks(), at: now };
    k = jwksCache.keys.find((x) => x.kid === kid);
  }
  return k;
}

/** Test hook: drop the cached JWKS. */
export function resetMicrosoftJwksCache() {
  jwksCache = undefined;
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

    let kid: unknown;
    let alg: unknown;
    try {
      ({ kid, alg } = decodeProtectedHeader(idToken));
    } catch {
      return fail("jwt_verify");
    }
    if (typeof kid !== "string" || !kid) return fail("jwt_verify");
    const jwk = await signingJwk(kid);
    if (!jwk) return fail("jwt_verify");
    // The key's own signing constraints: its alg (else RS256), use, key_ops.
    const keyAlg = jwk.alg ?? "RS256";
    if (
      jwk.kty !== "RSA" ||
      !RSA_SIG_ALGS.has(keyAlg) ||
      alg !== keyAlg ||
      (jwk.use !== undefined && jwk.use !== "sig") ||
      (jwk.key_ops !== undefined &&
        !(Array.isArray(jwk.key_ops) && jwk.key_ops.includes("verify")))
    )
      return fail("key_constraints");

    let claims: JWTPayload & Record<string, unknown>;
    try {
      const key = await importJWK(jwk, keyAlg);
      ({ payload: claims } = await jwtVerify(idToken, key, {
        algorithms: [keyAlg],
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
    if (typeof tid !== "string" || !TID_GUID.test(tid)) return fail("claims");
    const iss = `https://login.microsoftonline.com/${tid}/v2.0`;
    if (claims.iss !== iss) return fail("jwt_verify");
    // The signing key's issuer binds the key to tenants; none means refuse.
    if (
      typeof jwk.issuer !== "string" ||
      jwk.issuer.replaceAll("{tenantid}", tid) !== iss
    )
      return fail("key_issuer");

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
