import type { Env } from "../env.js";
import type { Principal } from "../principal.js";
import type { SessionRow } from "../services/tokens.js";
import { randomToken } from "./crypto.js";
import { csrfToken } from "./csrf.js";
import { adminHost, sessionHash } from "./session.js";

// Staging's test admin (#1053): the one identity agents sign in to the
// staging admin panel as. Its session comes only from R28 (the pinned
// staging-test-admin.yml OIDC caller), lives 1 h, and only one is live at a
// time. Its principal is kind "test-admin", so every admin check fails closed
// for it; prod refuses it before anything else.

/** The pinned identity: a code constant, never in ADMIN_IDENTITIES. */
export const TEST_ADMIN = {
  email: "rl-test-admin@test.invalid",
  sub: "rl-test-admin",
} as const;
export const TEST_ADMIN_LABEL = "test admin";
export const TEST_ADMIN_TTL_MS = 3_600_000;

export const isTestAdminRow = (row: { email: string; sub: string }) =>
  row.email === TEST_ADMIN.email && row.sub === TEST_ADMIN.sub;

/** The principal for a live test admin session row; null outside staging. */
export async function testAdminPrincipal(
  env: Env,
  row: SessionRow,
  sid: string,
): Promise<Principal | null> {
  if (env.OA_ENV !== "staging" || !isTestAdminRow(row)) return null;
  const key = `admin:${TEST_ADMIN.email}`;
  return {
    kind: "test-admin",
    actorKey: key,
    rateKey: key,
    label: TEST_ADMIN_LABEL,
    scopes: [],
    email: TEST_ADMIN.email,
    sub: TEST_ADMIN.sub,
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
 * A new test admin session (R28): every live one for the pinned identity is
 * revoked, with any agent token bound to it, in the same batch as the
 * insert, so at most one is live. Staging only.
 */
export async function mintTestAdminSession(
  env: Env,
  now: number,
): Promise<{ sid: string; expiresAt: number }> {
  if (env.OA_ENV !== "staging") throw new Error("test admin: staging only");
  const sid = randomToken(32);
  const expiresAt = now + TEST_ADMIN_TTL_MS;
  const live = `SELECT id_hash FROM sessions WHERE kind = 'admin' AND email = ? AND sub = ?
    AND revoked_at IS NULL`;
  await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare(
      `UPDATE agent_tokens SET revoked_at = ? WHERE revoked_at IS NULL
       AND session_hash IN (${live})`,
    ).bind(now, TEST_ADMIN.email, TEST_ADMIN.sub),
    env.PLATFORM_DB.prepare(
      `UPDATE sessions SET revoked_at = ? WHERE kind = 'admin' AND email = ? AND sub = ?
       AND revoked_at IS NULL`,
    ).bind(now, TEST_ADMIN.email, TEST_ADMIN.sub),
    env.PLATFORM_DB.prepare(
      `INSERT INTO sessions (id_hash, kind, host, email, sub, auth_at, created_at, expires_at)
       VALUES (?, 'admin', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      await sessionHash(sid),
      adminHost(env),
      TEST_ADMIN.email,
      TEST_ADMIN.sub,
      now,
      now,
      expiresAt,
    ),
  ]);
  return { sid, expiresAt };
}
