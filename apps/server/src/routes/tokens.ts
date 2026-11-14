import {
  newId,
  newPat,
  R,
  type Token,
  type TokenCreated,
  TokenCreateInputSchema,
  TokenPatchSchema,
} from "@oa/shared";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { requireUser } from "../auth/authz.js";
import { orgCan } from "../auth/policy.js";
import { getDb } from "../db/client.js";
import { tokens } from "../db/schema.js";
import type { Env } from "../env.js";
import { jsonBody } from "../http/body.js";
import { ApiError } from "../http/errors.js";
import { revokeUserLive } from "../runtime/revoke.js";
import { audit, auditText, userActor } from "../services/audit.js";
import { expireBusRoleProposalsOf } from "../services/bus.js";
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

const toToken = (r: {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  versionsPublished: number;
}): Token => ({
  id: r.id,
  label: r.label,
  createdAt: iso(r.createdAt),
  lastUsedAt: r.lastUsedAt == null ? null : iso(r.lastUsedAt),
  versionsPublished: r.versionsPublished,
});

export function mountTokens(app: AppType): void {
  app.get(R.tokens, async (c) => {
    const user = requireUser(c);
    const rows = await getDb(c.env)
      .select({
        id: tokens.id,
        label: tokens.label,
        createdAt: tokens.createdAt,
        lastUsedAt: tokens.lastUsedAt,
        versionsPublished: tokens.versionsPublished,
      })
      .from(tokens)
      .where(and(eq(tokens.userId, user.id), isNull(tokens.revokedAt)))
      .orderBy(desc(tokens.createdAt));
    return c.json(rows.map(toToken));
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
    // token.create (ids and the label, never the secret) joins the batch and
    // lands only when the insert did.
    const [res] = await c.env.DB.batch([
      c.env.DB.prepare(
        `insert into tokens (id, user_id, label, token_hash, created_at)
       select ?1, ?2, ?3, ?4, ?5
       where (select count(*) from tokens where user_id = ?2 and revoked_at is null) < ?6
         and exists (select 1 from users where id = ?2 and status = 'active')`,
      ).bind(id, user.id, label, await sha256Hex(token), now, MAX_ACTIVE),
      audit(c.env, "token.create", { type: "token", id }, userActor(user.id), {
        detail: { label },
        when: { sql: "changes() > 0", args: [] },
      }),
    ]);
    if (!res || (res.meta.changes === 0 && !(await isActive(c.env, user.id))))
      throw new ApiError("unauthorized", "Log in again");
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
      versionsPublished: 0,
      token,
    };
    return c.json(out, 201);
  });

  // The caller's own live token only (else 404); a label of 1-80 characters.
  // Not for a capped caller (404): DELETE stays open so they can revoke.
  app.patch("/api/v1/tokens/:id", async (c) => {
    const user = requireUser(c);
    // Renaming is for callers who may hold tokens: a capped caller only revokes.
    if (!orgCan(user, "tokens.create"))
      throw new ApiError("not_found", "Not found");
    const { label } = await jsonBody(c, TokenPatchSchema);
    const [row] = await getDb(c.env)
      .update(tokens)
      .set({ label })
      .where(
        and(
          eq(tokens.id, c.req.param("id")),
          eq(tokens.userId, user.id),
          isNull(tokens.revokedAt),
        ),
      )
      .returning({
        id: tokens.id,
        label: tokens.label,
        createdAt: tokens.createdAt,
        lastUsedAt: tokens.lastUsedAt,
        versionsPublished: tokens.versionsPublished,
      });
    if (!row) throw new ApiError("not_found", "Not found");
    return c.json(toToken(row));
  });

  app.delete("/api/v1/tokens/:id", async (c) => {
    const user = requireUser(c);
    const id = c.req.param("id");
    // token.revoke (id and label) is written in the same batch, only when the
    // revoke changed a row. The label is read first so it is stored cleaned.
    const was = await c.env.DB.prepare(
      "select label from tokens where id = ? and user_id = ?",
    )
      .bind(id, user.id)
      .first<{ label: string }>();
    const [res] = await c.env.DB.batch([
      c.env.DB.prepare(
        "update tokens set revoked_at = ?1 where id = ?2 and user_id = ?3 and revoked_at is null",
      ).bind(Date.now(), id, user.id),
      audit(c.env, "token.revoke", { type: "token", id }, userActor(user.id), {
        when: { sql: "changes() > 0", args: [] },
        detail: { label: auditText(was?.label ?? "") },
      }),
    ]);
    if (!res || res.meta.changes === 0)
      throw new ApiError("not_found", "Not found");
    // A PAT can open sockets as its user, so a revoke closes them (the
    // revocation lint's "user" guard); the person's session reconnects.
    await revokeUserLive(c.env, user.id, "token_revoked", c.executionCtx);
    // #1403: the pending bus role proposals this PAT made lapse with it.
    await expireBusRoleProposalsOf(c.env, user.id, {
      kind: "token",
      id: c.req.param("id"),
    });
    return c.body(null, 204);
  });
}
