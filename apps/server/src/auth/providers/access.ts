import { AUTH } from "@oa/shared";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "../../env.js";
import { ApiError, appOrigin } from "../../http/errors.js";
import { cookieKeys } from "../keys.js";
import { fail, safeEqual, tag } from "../oidc.js";
import type { OidcProvider, VerifiedIdentity } from "./types.js";

// Cloudflare Access for SaaS (OIDC): today's default sign-in.

const CLOCK_TOLERANCE_S = 60;

export function accessIssuer(env: Env): string {
  return `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/sso/oidc/${env.ACCESS_CLIENT_ID}`;
}

const redirectUri = (env: Env) => `${appOrigin(env)}${AUTH.callback}`;

const desc = (v: unknown) =>
  typeof v === "string"
    ? // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
      v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 200)
    : undefined;

/**
 * IdP error/error_description from a failed token response (never the body
 * otherwise). Access answers token errors with a 302 to
 * redirect_uri?error=…&error_description=…; others use a JSON body.
 */
async function tokenErrorInfo(
  res: Response,
): Promise<{ error?: string; description?: string }> {
  try {
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      const loc = res.headers.get("location");
      if (!loc) return {};
      const p = new URL(loc, "https://invalid.local").searchParams;
      return {
        error: tag(p.get("error")),
        description: desc(p.get("error_description")),
      };
    }
    if (res.status >= 400 && res.status < 500) {
      const text = await res.text();
      if (text.length > 16_384) return {};
      const j = JSON.parse(text) as {
        error?: unknown;
        error_description?: unknown;
      } | null;
      return { error: tag(j?.error), description: desc(j?.error_description) };
    }
    await res.body?.cancel();
  } catch {
    // non-JSON or malformed: stage alone is logged
  }
  return {};
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwks(issuer: string) {
  let s = jwksCache.get(issuer);
  if (!s) {
    s = createRemoteJWKSet(new URL(`${issuer}/jwks`));
    jwksCache.set(issuer, s);
  }
  return s;
}

export const accessProvider: OidcProvider = {
  id: "access",
  callbackPath: AUTH.callback,

  authorizeUrl(env, a) {
    const u = new URL(`${accessIssuer(env)}/authorization`);
    u.search = new URLSearchParams({
      client_id: env.ACCESS_CLIENT_ID,
      response_type: "code",
      scope: "openid email profile",
      redirect_uri: redirectUri(env),
      state: a.state,
      nonce: a.nonce,
      code_challenge: a.challenge,
      code_challenge_method: "S256",
      // A forced sign-in (#1372, a role proposal's confirm): Access must
      // authenticate again rather than reuse its SSO session.
      ...(a.reauth ? { prompt: "login", max_age: "0" } : {}),
    }).toString();
    return u.toString();
  },

  async redeem(env, a): Promise<VerifiedIdentity> {
    const issuer = accessIssuer(env);
    let idToken: unknown;
    try {
      const res = await fetch(`${issuer}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: a.code,
          redirect_uri: redirectUri(env),
          client_id: env.ACCESS_CLIENT_ID,
          client_secret: env.ACCESS_CLIENT_SECRET,
          code_verifier: a.verifier,
        }),
        redirect: "manual",
      });
      if (!res.ok)
        return fail(`token_http_${res.status}`, await tokenErrorInfo(res));
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return fail("token_bad_json");
      }
      idToken = (body as { id_token?: unknown } | null)?.id_token;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      return fail("token_fetch");
    }
    if (typeof idToken !== "string") return fail("no_id_token");

    let claims: Record<string, unknown>;
    try {
      ({ payload: claims } = await jwtVerify(idToken as string, jwks(issuer), {
        issuer,
        audience: env.ACCESS_CLIENT_ID,
        algorithms: ["RS256"],
        clockTolerance: CLOCK_TOLERANCE_S,
        requiredClaims: ["exp", "nonce"],
      }));
    } catch (e) {
      const err = e as { code?: unknown; claim?: unknown };
      return fail("jwt_verify", {
        code:
          typeof err?.code === "string"
            ? err.code.replace(/[^A-Z_]/g, "").slice(0, 64)
            : undefined,
        claim: tag(err?.claim),
      });
    }
    // Access sets aud to the client id; reject multi-audience tokens outright.
    const aud = claims.aud;
    if (
      Array.isArray(aud) &&
      (aud.length !== 1 || aud[0] !== env.ACCESS_CLIENT_ID)
    )
      return fail("aud");
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
    const email = claims.email;
    if (typeof email !== "string" || !email.includes("@")) return fail("email");
    if (claims.email_verified === false) return fail("email_unverified");
    const name =
      typeof claims.name === "string" && claims.name.trim()
        ? claims.name.trim().slice(0, 200)
        : null;
    // Normalization (and ASCII-only rejection) happens in upsertOnLogin.
    return {
      provider: "access",
      subject: typeof claims.sub === "string" ? claims.sub : "",
      email: email.trim(),
      name,
      tenant: null,
    };
  },
};
