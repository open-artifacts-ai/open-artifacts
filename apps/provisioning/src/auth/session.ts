import type { Env } from "../env.js";
import { type Principal, type Refusal, refusal } from "../principal.js";
import type { SessionRow } from "../services/tokens.js";
import { randomToken, sameString, sha256Hex } from "./crypto.js";
import { csrfToken } from "./csrf.js";
import { isAdminIdentity } from "./identities.js";

// Admin sessions (design v7 4.5): `__Host-oa-admin=<sid>` (32 random bytes),
// Secure, HttpOnly, SameSite=Strict, 8 h absolute. D1 keeps sha256(sid) and
// auth_at, never the sid.

export const SESSION_COOKIE = "__Host-oa-admin";
export const SESSION_TTL_MS = 8 * 3600_000;
/**
 * A sign-in for the session's own pair with less than this left gets a new
 * session, not the old one (9A.3.2 step 4: MCP consent sends it here).
 */
export const SESSION_RENEW_UNDER_MS = 3_600_000;
const SID_RE = /^[A-Za-z0-9_-]{43}$/;

export const adminHost = (env: Env) => `admin.${env.APP_DOMAIN}`;
export const adminOrigin = (env: Env) => `https://${adminHost(env)}`;

/** The named cookie's value, or null. */
export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name)
      return part.slice(i + 1).trim();
  }
  return null;
}

export const sessionHash = (sid: string) => sha256Hex(sid);

export const sessionCookie = (sid: string) =>
  `${SESSION_COOKIE}=${sid}; Max-Age=${SESSION_TTL_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Strict`;
export const clearSessionCookie = () =>
  `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;

/** Inserts an admin session; the sid goes only into the cookie. */
export async function createSession(
  env: Env,
  s: { email: string; sub: string; authAt: number },
  now: number,
): Promise<{ sid: string; expiresAt: number }> {
  const sid = randomToken(32);
  const expiresAt = now + SESSION_TTL_MS;
  await env.PLATFORM_DB.prepare(
    `INSERT INTO sessions (id_hash, kind, host, email, sub, auth_at, created_at, expires_at)
     VALUES (?, 'admin', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      await sessionHash(sid),
      adminHost(env),
      s.email,
      s.sub,
      s.authAt,
      now,
      expiresAt,
    )
    .run();
  return { sid, expiresAt };
}

/** The live admin session row for `sid` on this env's admin host, or null. */
export async function liveSession(
  env: Env,
  sid: string,
  now: number,
): Promise<SessionRow | null> {
  const hash = await sessionHash(sid);
  const row = await env.PLATFORM_DB.prepare(
    `SELECT * FROM sessions WHERE id_hash = ? AND kind = 'admin' AND host = ?
       AND revoked_at IS NULL AND expires_at > ?`,
  )
    .bind(hash, adminHost(env), now)
    .first<SessionRow>();
  // The lookup finds the row; the constant-time compare decides (4.1).
  return row && sameString(row.id_hash, hash) ? row : null;
}

/**
 * The admin principal for the request's session cookie: the row is live and
 * its (email, sub) is still in ADMIN_IDENTITIES (read on every request, 4.1).
 */
export async function sessionPrincipal(
  req: Request,
  env: Env,
  now: number,
): Promise<Principal | Refusal> {
  const sid = readCookie(req, SESSION_COOKIE);
  if (!sid || !SID_RE.test(sid)) return refusal("unauthenticated");
  const row = await liveSession(env, sid, now);
  if (!row || !isAdminIdentity(env.ADMIN_IDENTITIES, row.email, row.sub))
    return refusal("unauthenticated");
  const key = `admin:${row.email}`;
  return {
    kind: "admin",
    actorKey: key,
    rateKey: key,
    label: row.email,
    scopes: [],
    email: row.email,
    sub: row.sub,
    authAt: row.auth_at,
    session: {
      hash: row.id_hash,
      csrf: await csrfToken(env, sid),
      expiresAt: row.expires_at,
      authAt: row.auth_at,
    },
  };
}

/**
 * A sign-in for the session's own (email, sub) (R11 reauth, a second
 * sign-in): the sid, expiry and every token bound to it stay; only auth_at
 * moves.
 */
export async function renewSession(
  env: Env,
  hash: string,
  authAt: number,
): Promise<void> {
  await env.PLATFORM_DB.prepare(
    "UPDATE sessions SET auth_at = ? WHERE id_hash = ? AND revoked_at IS NULL",
  )
    .bind(authAt, hash)
    .run();
}

/** An OAuth grant in the library's store (R24 revokes it with its row). */
export type LibraryGrant = { grantId: string; oauthUser: string };

/** A token row revoked with its session (R24). */
export type RevokedToken = {
  id: string;
  kind: "oat" | "oauth";
  label: string;
  scopes: string;
  grant_id: string | null;
  oauth_user: string | null;
};

/**
 * Revokes the session and every live agent token minted under it, both
 * kinds, in one batch (R24). D1 is authoritative: tokenPrincipal refuses a
 * revoked row even while the library's KV grant lingers (9A.3.3).
 */
export async function revokeSession(
  env: Env,
  hash: string,
  now: number,
): Promise<RevokedToken[]> {
  const [, toks] = await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      "UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL",
    ).bind(now, hash),
    env.PLATFORM_DB.prepare(
      `UPDATE agent_tokens SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL
       RETURNING id, kind, label, scopes, grant_id, oauth_user`,
    ).bind(now, hash),
  ]);
  return ((toks?.results ?? []) as RevokedToken[]).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}
