import {
  AUDIT_RETENTION_MS,
  type AuditAction,
  AuditActionSchema,
  type AuditEvent,
  type AuditReason,
  AuditReasonSchema,
  isId,
  newId,
  type Page,
} from "@oa/shared";
import { sql } from "drizzle-orm";
import { deriveKey } from "../auth/keys.js";
import { getDb } from "../db/client.js";
import { auditEvents } from "../db/schema.js";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { logInfo } from "../log.js";
import { hmacSign, hmacVerify } from "../util/crypto.js";

// The audit log (P3 T8). audit() is a statement, never a write: callers put it
// in the same D1 batch as the change it records, so both commit or neither
// does. Rows hold ids and enums only; the actor's email is joined at read
// time, never stored, and no code, token or other address is ever written.
// Rows are never updated; the daily cron deletes those past 400 days
// (AUDIT_RETENTION_MS, sweepAuditEvents below; HOSTED_CONTRACT.md).

/** Who did it: a signed-in user, directory sync, or the system (cron, alarms). */
export type AuditActor = {
  kind: "user" | "sync" | "system";
  id: string | null;
};

export type AuditExtra = {
  spaceId?: string | null;
  reason?: AuditReason;
  /** Enums and ids only. `reason` is reserved (stored alongside, read back as AuditEvent.reason). */
  detail?: Record<string, unknown>;
  /**
   * Inserts the row only when this SQL condition holds after the change ran
   * (e.g. the share row exists, or `changes() > 0` right after the change),
   * so a no-op or lost race writes no audit row.
   */
  when?: { sql: string; args: unknown[] };
  /**
   * Detail fields computed in SQL when the row is written (e.g. `changes()`
   * of the statement just before), merged over `detail`: a JSON object
   * expression such as `json_object('moved', changes())`.
   */
  detailSql?: { sql: string; args: unknown[] };
};

const insertSql = (detailSql?: string) => `insert into audit_events
  (id, at, actor_kind, actor_id, action, target_type, target_id, space_id, detail)
  select ?, ?, ?, ?, ?, ?, ?, ?, ${detailSql ? `json_patch(?, ${detailSql})` : "?"}`;

/** One audit row, as a statement for the caller's own batch. */
export function audit(
  env: Env,
  action: AuditAction,
  target: AuditEvent["target"],
  actor: AuditActor,
  extra: AuditExtra = {},
): D1PreparedStatement {
  // `reason` is stored inside detail; a caller's own key would shadow it.
  if (extra.detail && "reason" in extra.detail)
    throw new Error("audit: pass reason as extra.reason, not in detail");
  const detail = {
    ...extra.detail,
    ...(extra.reason && { reason: extra.reason }),
  };
  const insert = insertSql(extra.detailSql?.sql);
  const sql = extra.when ? `${insert} where ${extra.when.sql}` : insert;
  return stmt(env.DB, sql).bind(
    newId(),
    Date.now(),
    actor.kind,
    actor.id,
    action,
    target.type,
    target.id,
    extra.spaceId ?? null,
    JSON.stringify(detail),
    ...(extra.detailSql?.args ?? []),
    ...(extra.when?.args ?? []),
  );
}

/** A user acting on their own behalf. */
export const userActor = (id: string): AuditActor => ({ kind: "user", id });

/**
 * auth.signin for P2's admission seam: the provider and, when verified, the
 * tenant domain. Never the address. It records the admission (the user row
 * touched on sign-in) and commits with it; the session cookie is issued after
 * the batch, so a sign-in that never reaches the browser can still have a row.
 */
export const signInAudit = (
  env: Env,
  userId: string,
  provider: string,
  tenant?: string | null,
  when?: AuditExtra["when"],
): D1PreparedStatement =>
  audit(env, "auth.signin", { type: "user", id: userId }, userActor(userId), {
    detail: { provider, ...(tenant ? { tenant } : {}) },
    ...(when ? { when } : {}),
  });

/**
 * signInAudit keyed by the (normalized) email, for an admission that writes
 * the user row in the same batch and so has no id yet (Access's
 * upsertOnLogin): the subselect reads the row the batch just wrote. A drizzle
 * insert (drizzle's raw `run` can't join a D1 batch with parameters), in the
 * table's column order.
 */
export const signInAuditByEmail = (env: Env, email: string, provider: string) =>
  getDb(env)
    .insert(auditEvents)
    .select(
      sql`select ${newId()}, ${Date.now()}, 'user', u.id, 'auth.signin', 'user', u.id, null, ${JSON.stringify({ provider })}
        from users u where u.email = ${email}`,
    );

// ------------------------------------------------------------------- read

type Row = {
  id: string;
  at: number;
  actorKind: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  spaceId: string | null;
  detail: string;
};

const ACTOR_KINDS = new Set(["user", "sync", "system"]);
const ACTIONS: ReadonlySet<string> = new Set(AuditActionSchema.options);
const TARGETS = new Set([
  "space",
  "artifact",
  "user",
  "mapping",
  "group",
  "directory",
]);

/**
 * Newest first, keyset on (at, id) (audit_events_at_idx; WITHOUT ROWID, so
 * the index carries id). Only contract rows: P2's test-hook rows
 * (actor_kind 'test_hook') are not AuditEvents and stay out.
 */
const KINDS = "e.actor_kind in ('user', 'sync', 'system')";
/** Keyset bound: rows after (`<`) or from (`<=`) the key (?2, ?3). */
const bound = (op: "<" | "<=" | null) =>
  op ? ` and (e.at < ?2 or (e.at = ?2 and e.id ${op} ?3))` : "";
const PAGE_SQL = (
  op: "<" | "<=" | null,
) => `select e.id, e.at, e.actor_kind as actorKind,
    e.actor_id as actorId, u.email as actorEmail, e.action,
    e.target_type as targetType, e.target_id as targetId,
    e.space_id as spaceId, e.detail
  from audit_events e left join users u on u.id = e.actor_id
  where ${KINDS}${bound(op)}
  order by e.at desc, e.id desc limit ?1`;
/** Keys only, at an offset: the export's range ends (?1 limit, ?4 offset). */
const KEYS_SQL = (op: "<" | null) => `select e.at as a, e.id as i
  from audit_events e where ${KINDS}${bound(op)}
  order by e.at desc, e.id desc limit ?1 offset ?4`;

function parseDetail(s: string): {
  reason: AuditReason | null;
  detail: Record<string, unknown> | null;
} {
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return { reason: null, detail: null };
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    return { reason: null, detail: null };
  const { reason, ...rest } = v as Record<string, unknown>;
  const r = AuditReasonSchema.safeParse(reason);
  return {
    reason: r.success ? r.data : null,
    detail: Object.keys(rest).length ? rest : null,
  };
}

function toEvent(r: Row): AuditEvent | null {
  if (
    !ACTOR_KINDS.has(r.actorKind) ||
    !ACTIONS.has(r.action) ||
    !TARGETS.has(r.targetType) ||
    r.targetId === null
  )
    return null;
  return {
    id: r.id,
    at: new Date(r.at).toISOString(),
    actor: {
      kind: r.actorKind as AuditEvent["actor"]["kind"],
      id: r.actorId,
      email: r.actorKind === "user" ? r.actorEmail : null,
    },
    action: r.action as AuditAction,
    target: {
      type: r.targetType as AuditEvent["target"]["type"],
      id: r.targetId,
    },
    spaceId: r.spaceId,
    ...parseDetail(r.detail),
  };
}

type Cursor = { a: number; i: string };

/**
 * Where a cursor may be used: which listing, and the request's filters in
 * canonical form (auditFilters). A cursor only verifies for the same scope.
 */
export type CursorScope = { kind: "list" | "export"; filters: string };

/** Query params that narrow the audit listings. None yet; a filter added later joins this list. */
export const AUDIT_FILTER_KEYS: readonly string[] = [];

/**
 * The request's filters in a canonical order: only known filter names (others,
 * such as a cache-buster, are ignored, so they never break page 2). Sorted by
 * name, values in request order, so `?a=1&b=2` and `?b=2&a=1` bind the same
 * cursor.
 */
export function auditFilters(
  q: Record<string, string[]>,
  keys: readonly string[] = AUDIT_FILTER_KEYS,
): string {
  return JSON.stringify(
    Object.keys(q)
      .filter((k) => keys.includes(k))
      .sort()
      .map((k) => [k, q[k] ?? []]),
  );
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const b64url = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64url = (s: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    ),
  );

const installOf = (env: Env) => env.INSTALL_ID?.trim() ?? "";
const cursorKey = (env: Env) => deriveKey(env, "oa:audit-cursor");

/**
 * Opaque: b64url(JSON { p: position, n: installId, k: kind, f: filters })
 * "." HMAC (oa:audit-cursor, from SESSION_SECRET). Bound to this install and
 * to the scope it was issued for.
 */
async function encodeCursor(
  env: Env,
  c: Cursor,
  scope: CursorScope,
): Promise<string> {
  const body = b64url(
    JSON.stringify({
      p: [c.a, c.i],
      n: installOf(env),
      k: scope.kind,
      f: scope.filters,
    }),
  );
  return `${body}.${await hmacSign(await cursorKey(env), body)}`;
}

/**
 * Anything that does not verify (bad MAC, another install or secret, another
 * listing or other filters, a malformed position) is 400. The MAC check is
 * constant-time (hmacVerify) and runs before the payload is parsed.
 */
async function decodeCursor(
  env: Env,
  s: string,
  scope: CursorScope,
): Promise<Cursor> {
  const invalid = () =>
    new ApiError("bad_request", "Invalid cursor", {
      path: "cursor",
      reason: "invalid",
    });
  const [body, sig, extra] = s.split(".");
  if (
    extra !== undefined ||
    !body ||
    !sig ||
    s.length > 2048 ||
    !B64URL.test(body)
  )
    throw invalid();
  if (!(await hmacVerify(await cursorKey(env), body, sig))) throw invalid();
  let v: { p?: unknown; n?: unknown; k?: unknown; f?: unknown };
  try {
    v = JSON.parse(unb64url(body));
  } catch {
    throw invalid();
  }
  const p = v?.p;
  if (
    !v ||
    typeof v !== "object" ||
    v.n !== installOf(env) ||
    v.k !== scope.kind ||
    v.f !== scope.filters ||
    !Array.isArray(p) ||
    p.length !== 2 ||
    !Number.isSafeInteger(p[0]) ||
    typeof p[1] !== "string" ||
    !isId(p[1])
  )
    throw invalid();
  return { a: p[0] as number, i: p[1] };
}

export const AUDIT_PAGE_MAX = 100;

/** One page of the audit log, newest first. Callers check audit.read. */
export async function listAudit(
  env: Env,
  cursor: string | undefined,
  limit: number,
  filters = auditFilters({}),
): Promise<Page<AuditEvent>> {
  const scope: CursorScope = { kind: "list", filters };
  const after = cursor ? await decodeCursor(env, cursor, scope) : null;
  const q = stmt(env.DB, PAGE_SQL(after ? "<" : null));
  const { results } = await (after
    ? q.bind(limit + 1, after.a, after.i)
    : q.bind(limit + 1)
  ).all<Row>();
  const more = results.length > limit;
  const rows = more ? results.slice(0, limit) : results;
  const last = rows[rows.length - 1];
  return {
    items: rows.map(toEvent).filter((e): e is AuditEvent => e !== null),
    nextCursor:
      more && last
        ? await encodeCursor(env, { a: last.at, i: last.id }, scope)
        : null,
  };
}

const EXPORT_CHUNK = 500;
/** Pages per export request; past it the response names the next cursor. */
export const EXPORT_PAGES = 10;

/** (at, id) order, newest first: true when `r` sorts before or at `k`. */
const atOrBefore = (r: Cursor, k: Cursor) =>
  r.a > k.a || (r.a === k.a && r.i >= k.i);

/**
 * Up to EXPORT_PAGES pages of events as NDJSON, newest first, from `cursor`
 * (exclusive). The range is fixed before streaming: one batch reads its
 * first key and the keys at N and N+1 (N = EXPORT_PAGES * EXPORT_CHUNK), so
 * the request reads at most N rows, one keyset page per pull, and
 * `nextCursor` (the N-th key, when an N+1-th exists) continues it.
 */
export async function exportAudit(
  env: Env,
  cursor: string | undefined,
  filters = auditFilters({}),
): Promise<{ stream: ReadableStream<Uint8Array>; nextCursor: string | null }> {
  const scope: CursorScope = { kind: "export", filters };
  const after = cursor ? await decodeCursor(env, cursor, scope) : null;
  const n = EXPORT_CHUNK * EXPORT_PAGES;
  const keys = (limit: number, offset: number) => {
    const q = stmt(env.DB, KEYS_SQL(after ? "<" : null));
    return after
      ? q.bind(limit, after.a, after.i, offset)
      : q.bind(limit, null, null, offset);
  };
  const [first, edge] = await env.DB.batch<Cursor>([
    keys(1, 0),
    keys(2, n - 1),
  ]);
  const top = first?.results[0];
  const end = edge?.results[0] ?? null;
  const nextCursor =
    end && (edge?.results.length ?? 0) > 1
      ? await encodeCursor(env, end, scope)
      : null;
  const enc = new TextEncoder();
  // The first page starts at `top` (inclusive), later pages after the last row.
  let from: { k: Cursor; op: "<" | "<=" } | null = top
    ? { k: top, op: "<=" }
    : null;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!from) {
        controller.close();
        return;
      }
      const { results } = await stmt(env.DB, PAGE_SQL(from.op))
        .bind(EXPORT_CHUNK, from.k.a, from.k.i)
        .all<Row>();
      let out = "";
      let reached = results.length < EXPORT_CHUNK;
      for (const r of results) {
        const k = { a: r.at, i: r.id };
        if (end && !atOrBefore(k, end)) {
          reached = true;
          break;
        }
        const e = toEvent(r);
        if (e) out += `${JSON.stringify(e)}\n`;
        if (end && k.a === end.a && k.i === end.i) reached = true;
      }
      if (out) controller.enqueue(enc.encode(out));
      const last = results[results.length - 1];
      from =
        reached || !last ? null : { k: { a: last.at, i: last.id }, op: "<" };
      if (!from) controller.close();
    },
  });
  return { stream, nextCursor };
}

/** Rows one sweep statement deletes (D1 bills 1 row written, 4 read, per row; test/d1-rows). */
export const AUDIT_SWEEP_BATCH = 1000;
/** Sweep statements per cron run: at most 5000 rows a day. */
export const AUDIT_SWEEP_STATEMENTS = 5;

// Oldest first through audit_events_at_idx (the subquery is an index-only
// range scan; each delete is a primary-key lookup). D1 has no DELETE ... LIMIT.
const SWEEP_SQL = `delete from audit_events where id in
  (select id from audit_events where at < ? order by at limit ?)`;

/**
 * Daily cron: deletes audit rows older than AUDIT_RETENTION_MS (400 days),
 * oldest first, at most `statements` × `batch` rows per run so a large backlog
 * can't exceed the invocation's query or CPU limits; the rest goes the next
 * day. Logs the count only (no row content). Returns the rows deleted.
 */
export async function sweepAuditEvents(
  env: Env,
  now: number,
  batch = AUDIT_SWEEP_BATCH,
  statements = AUDIT_SWEEP_STATEMENTS,
): Promise<number> {
  const cutoff = now - AUDIT_RETENTION_MS;
  let deleted = 0;
  let more = false;
  for (let i = 0; i < statements; i++) {
    const r = await stmt(env.DB, SWEEP_SQL).bind(cutoff, batch).run();
    deleted += r.meta.changes;
    more = r.meta.changes >= batch;
    if (!more) break;
  }
  if (deleted > 0) logInfo("audit_swept", { deleted, more });
  return deleted;
}
