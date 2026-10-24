import { isPat, newId, newPat } from "@oa/shared";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { tokens } from "../db/schema.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { sha256Hex } from "../util/crypto.js";

const HOUR = 3600 * 1000;

type TokenRow = {
  id: string;
  userId: string;
  label: string;
  revokedAt: number | null;
  lastUsedAt: number | null;
};
const TOKEN_BY_HASH =
  "select id, user_id as userId, label, revoked_at as revokedAt, last_used_at as lastUsedAt from tokens where token_hash = ? limit 1";

const CREATE_PAT = `insert into tokens (id, user_id, label, token_hash, created_at)
  select ?1, ?2, ?3, ?4, ?5
  where exists (select 1 from users where id = ?2 and status = 'active')`;

export async function createPat(
  env: Env,
  userId: string,
  label: string,
): Promise<{ id: string; token: string }> {
  const id = newId();
  const token = newPat();
  // Only for an active user, in the same statement: a PAT inserted after a
  // suspension revoked the others would come back on unsuspend (P3 T6).
  const res = await stmt(env.DB, CREATE_PAT)
    .bind(id, userId, label, await sha256Hex(token), Date.now())
    .run();
  if (res.meta.changes === 0)
    throw new ApiError("unauthorized", "Sign in again");
  return { id, token };
}

export async function verifyPat(
  env: Env,
  token: string,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<{ userId: string; tokenId: string; label: string } | null> {
  if (!isPat(token)) return null;
  const row = await stmt(env.DB, TOKEN_BY_HASH)
    .bind(await sha256Hex(token))
    .first<TokenRow>();
  if (!row || row.revokedAt != null) return null;
  const now = Date.now();
  if (row.lastUsedAt == null || row.lastUsedAt < now - HOUR) {
    const upd = getDb(env)
      .update(tokens)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(tokens.id, row.id),
          or(isNull(tokens.lastUsedAt), lt(tokens.lastUsedAt, now - HOUR)),
        ),
      )
      .then(() => undefined);
    if (ctx) ctx.waitUntil(upd);
    else await upd;
  }
  return { userId: row.userId, tokenId: row.id, label: row.label };
}
