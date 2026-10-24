import {
  newId,
  newPat,
  R,
  type Token,
  type TokenCreated,
  TokenCreateInputSchema,
} from "@oa/shared";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { requireUser } from "../auth/authz.js";
import { orgCan } from "../auth/policy.js";
import { getDb } from "../db/client.js";
import { tokens } from "../db/schema.js";
import type { Env } from "../env.js";
import { jsonBody } from "../http/body.js";
import { ApiError } from "../http/errors.js";
import { sha256Hex } from "../util/crypto.js";
import type { AppType } from "./index.js";

const MAX_ACTIVE = 50;

const isActive = async (env: Env, id: string) =>
  (await env.DB.prepare(
    "select 1 as x from users where id = ? and status = 'active'",
  )
    .bind(id)
    .first()) !== null;
const iso = (ms: number) => new Date(ms).toISOString();

export function mountTokens(app: AppType): void {
  app.get(R.tokens, async (c) => {
    const user = requireUser(c);
    const rows = await getDb(c.env)
      .select({
        id: tokens.id,
        label: tokens.label,
        createdAt: tokens.createdAt,
        lastUsedAt: tokens.lastUsedAt,
      })
      .from(tokens)
      .where(and(eq(tokens.userId, user.id), isNull(tokens.revokedAt)))
      .orderBy(desc(tokens.createdAt));
    const out: Token[] = rows.map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: iso(r.createdAt),
      lastUsedAt: r.lastUsedAt == null ? null : iso(r.lastUsedAt),
    }));
    return c.json(out);
  });

  app.post(R.tokens, async (c) => {
    const user = requireUser(c);
    if (c.var.tokenId || !orgCan(user, "tokens.create"))
      throw new ApiError("not_found", "Not found");
    const { label } = await jsonBody(c, TokenCreateInputSchema);
    // Session-only: a PAT cannot mint PATs.
    const id = newId();
    const token = newPat();
    const now = Date.now();
    // Atomic cap: the count and the insert are one statement. Only while the
    // user is still active: a suspension that committed after this request's
    // user read already revoked their PATs, and this one must not outlive it
    // into an unsuspend (P3 T6).
    const res = await c.env.DB.prepare(
      `insert into tokens (id, user_id, label, token_hash, created_at)
       select ?1, ?2, ?3, ?4, ?5
       where (select count(*) from tokens where user_id = ?2 and revoked_at is null) < ?6
         and exists (select 1 from users where id = ?2 and status = 'active')`,
    )
      .bind(id, user.id, label, await sha256Hex(token), now, MAX_ACTIVE)
      .run();
    if (res.meta.changes === 0 && !(await isActive(c.env, user.id)))
      throw new ApiError("unauthorized", "Sign in again");
    if (res.meta.changes === 0)
      throw new ApiError(
        "bad_request",
        `At most ${MAX_ACTIVE} active tokens; revoke one first`,
      );
    const out: TokenCreated = {
      id,
      label,
      createdAt: iso(now),
      lastUsedAt: null,
      token,
    };
    return c.json(out, 201);
  });

  app.delete("/api/v1/tokens/:id", async (c) => {
    const user = requireUser(c);
    const res = await getDb(c.env)
      .update(tokens)
      .set({ revokedAt: Date.now() })
      .where(
        and(
          eq(tokens.id, c.req.param("id")),
          eq(tokens.userId, user.id),
          isNull(tokens.revokedAt),
        ),
      )
      .returning({ id: tokens.id });
    if (res.length === 0) throw new ApiError("not_found", "Not found");
    return c.body(null, 204);
  });
}
