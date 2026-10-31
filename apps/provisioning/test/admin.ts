import type { Principal } from "../src/principal.js";
import type { SessionRow } from "../src/services/tokens.js";
import { fakeEnv } from "./fakes.js";

/** A fresh admin per case (own email, sub, session), so cases share no rows. */
export async function seedAdmin(
  db: D1Database,
  now: number,
  over: Partial<SessionRow> = {},
) {
  const n = crypto.randomUUID().slice(0, 8);
  const session: SessionRow = {
    id_hash: `sh_${crypto.randomUUID()}`,
    kind: "admin",
    host: "admin.hosted.test",
    email: `a-${n}@example.com`,
    sub: `sub-${n}`,
    auth_at: now,
    created_at: now,
    expires_at: now + 8 * 3_600_000,
    revoked_at: null,
    last_seen_at: null,
    ...over,
  };
  await db
    .prepare(
      "INSERT INTO sessions (id_hash, kind, host, email, sub, auth_at, created_at, expires_at, revoked_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )
    .bind(
      session.id_hash,
      session.kind,
      session.host,
      session.email,
      session.sub,
      session.auth_at,
      session.created_at,
      session.expires_at,
      session.revoked_at,
      session.last_seen_at,
    )
    .run();
  const principal: Principal = {
    kind: "admin",
    actorKey: `admin:${session.email}`,
    rateKey: `admin:${session.email}`,
    label: session.email,
    scopes: [],
    email: session.email,
    sub: session.sub,
    authAt: session.auth_at,
    session: {
      hash: session.id_hash,
      csrf: "csrf",
      expiresAt: session.expires_at,
      authAt: session.auth_at,
    },
  };
  const { env, limits } = fakeEnv({
    PLATFORM_DB: db,
    ADMIN_IDENTITIES: `other@example.com:9,${session.email}:${session.sub}`,
  });
  return { session, principal, env, limits };
}

export const requestId = () => `req_${crypto.randomUUID().replace(/-/g, "")}`;
