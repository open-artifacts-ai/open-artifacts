// Google ID token verification, shared by the server (direct transport and
// the broker's raw token) and the auth broker. No Env, no config: the caller
// passes its client id and verified domains.
import {
  createRemoteJWKSet,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";
import { inDomains } from "./domains.js";
import { normalizeEmail } from "./email.js";

export const GOOGLE_ISSUERS = [
  "https://accounts.google.com",
  "accounts.google.com",
] as const;
export const GOOGLE_AUTHORIZE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** RFC 7009 revocation (a refresh token revokes the whole grant). */
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

/**
 * Directory sync consent (P3): read-only Admin SDK scopes plus openid email,
 * requested by the broker (hosted) or the install itself (direct transport).
 * The install refuses a grant missing any of them.
 */
export const GOOGLE_DIRECTORY_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.readonly",
  "https://www.googleapis.com/auth/admin.directory.domain.readonly",
  "https://www.googleapis.com/auth/admin.reports.audit.readonly",
] as const;

/** Google reports the `email` scope back under its long name. */
const SCOPE_ALIASES: Record<string, string> = {
  "https://www.googleapis.com/auth/userinfo.email": "email",
};

/** True when `granted` (the token response's space-separated `scope`) covers every directory scope. */
export function hasDirectoryScopes(granted: string): boolean {
  const got = new Set(
    granted
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => SCOPE_ALIASES[s] ?? s),
  );
  return GOOGLE_DIRECTORY_SCOPES.every((s) => got.has(s));
}

const CLOCK_TOLERANCE_S = 60;
/** Google ID tokens live 1 h; refuse anything issued earlier than that. */
const MAX_TOKEN_AGE = "1h";
const MAX_NAME = 200;

export type GoogleIdentity = {
  sub: string;
  email: string;
  name: string | null;
  /** The verified Workspace domain; always one of the caller's domains. */
  hd: string;
};

export type GoogleTokenStage =
  | "jwt_verify"
  | "aud"
  | "azp"
  | "nonce"
  | "email_unverified"
  | "tenant"
  | "claims";

/** Why a token was refused; `stage` is safe to log, nothing else is kept. */
export class GoogleTokenError extends Error {
  constructor(public stage: GoogleTokenStage) {
    super(`google id token: ${stage}`);
    this.name = "GoogleTokenError";
  }
}

let googleJwks: JWTVerifyGetKey | undefined;

const enc = new TextEncoder();

/** Constant-time equality of two strings (compares their SHA-256 digests). */
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
 * Verifies a Google ID token for one install, in this order: signature
 * (RS256 only, Google's JWKS unless `jwks` is given), iss, aud, exp/iat
 * (60 s skew, issued at most 1 h ago) and required claims; then aud is exactly the client id; azp,
 * when present, is the client id; nonce equals this flow's nonce (constant
 * time); email_verified is true; the email normalizes (normalizeEmail); hd is one of `domains` exactly. The email
 * domain is never consulted.
 */
export async function verifyGoogleIdToken(
  opts: {
    clientId: string;
    domains: readonly string[];
    jwks?: JWTVerifyGetKey;
    /** ms; defaults to the clock. */
    now?: number;
  },
  idToken: string,
  nonce: string,
): Promise<GoogleIdentity> {
  let claims: JWTPayload & Record<string, unknown>;
  try {
    googleJwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
    ({ payload: claims } = await jwtVerify(idToken, opts.jwks ?? googleJwks, {
      algorithms: ["RS256"],
      issuer: [...GOOGLE_ISSUERS],
      audience: opts.clientId,
      clockTolerance: CLOCK_TOLERANCE_S,
      maxTokenAge: MAX_TOKEN_AGE,
      requiredClaims: ["sub", "exp", "iat", "nonce", "email"],
      ...(opts.now !== undefined ? { currentDate: new Date(opts.now) } : {}),
    }));
  } catch {
    throw new GoogleTokenError("jwt_verify");
  }
  const aud = claims.aud;
  if (
    !(
      aud === opts.clientId ||
      (Array.isArray(aud) && aud.length === 1 && aud[0] === opts.clientId)
    )
  )
    throw new GoogleTokenError("aud");
  if (claims.azp !== undefined && claims.azp !== opts.clientId)
    throw new GoogleTokenError("azp");
  if (
    typeof claims.nonce !== "string" ||
    !(await sameString(claims.nonce, nonce))
  )
    throw new GoogleTokenError("nonce");
  if (claims.email_verified !== true)
    throw new GoogleTokenError("email_unverified");
  if (!inDomains(opts.domains, claims.hd)) throw new GoogleTokenError("tenant");
  const { sub } = claims;
  const email =
    typeof claims.email === "string" ? normalizeEmail(claims.email) : null;
  if (typeof sub !== "string" || !sub || !email)
    throw new GoogleTokenError("claims");
  const name =
    typeof claims.name === "string" && claims.name.trim()
      ? claims.name.trim().slice(0, MAX_NAME)
      : null;
  return { sub, email, name, hd: claims.hd as string };
}
