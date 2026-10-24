import { type DirectoryBinding, DirectoryBindingSchema } from "@oa/shared";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { logInfo, logWarn } from "../log.js";
import { type AuditActor, audit } from "../services/audit.js";
import { directoryClient } from "./client.js";

// The directory connection at rest, in P3's directory_state key/value table
// (no migration; T13's DirectorySync reads the same rows):
// - "binding": the live DirectoryBinding JSON;
// - "refresh": the live sealed refresh token (crypto.ts), never plaintext;
// - "pending.binding", "pending.refresh": a consent waiting for confirm. A
//   reconnect keeps the live pair (and its sync) until confirm swaps these
//   in; cancel and expiry delete only these;
// - "grant.sub": the Google account behind the live token. Google revokes a
//   whole grant (client + account), so a token is never revoked while it
//   shares its account with the token that stays;
// - "connect.pending": the one connect in flight, {h: sha256(state), u, exp},
//   consumed by its callback (single use);
// - "connect.confirm": a consent waiting for its owner, {u, exp, count,
//   capped}; T13 must not sync while it exists;
// - "binding.initial": the initial binding pass, {done, cursor} (T13
//   continues a pass whose cursor is set).

export const K = {
  binding: "binding",
  refresh: "refresh",
  pendingBinding: "pending.binding",
  pendingRefresh: "pending.refresh",
  grantSub: "grant.sub",
  pending: "connect.pending",
  confirm: "connect.confirm",
  initial: "binding.initial",
} as const;

export const UPSERT = `insert into directory_state (key, value) values (?, ?)
  on conflict (key) do update set value = excluded.value`;

export const putState = (env: Env, key: string, value: string) =>
  stmt(env.DB, UPSERT).bind(key, value);

const READ = "select key, value from directory_state where key in (?, ?)";

/** The live (or pending) binding and sealed refresh token, in one statement. */
export async function readBinding(
  env: Env,
  which: "live" | "pending" = "live",
): Promise<{ binding: DirectoryBinding | null; sealed: string | null }> {
  const [bk, rk] =
    which === "live"
      ? [K.binding, K.refresh]
      : [K.pendingBinding, K.pendingRefresh];
  const { results } = await stmt(env.DB, READ)
    .bind(bk, rk)
    .all<{ key: string; value: string }>();
  let binding: DirectoryBinding | null = null;
  let sealed: string | null = null;
  for (const r of results) {
    if (r.key === rk) sealed = r.value;
    else {
      try {
        const p = DirectoryBindingSchema.safeParse(JSON.parse(r.value));
        binding = p.success ? p.data : null;
      } catch {
        binding = null;
      }
    }
  }
  return { binding, sealed };
}

export type InitialPass = { done: boolean; cursor: string | null };

export async function readInitial(env: Env): Promise<InitialPass> {
  const row = await stmt(
    env.DB,
    "select value from directory_state where key = ?",
  )
    .bind(K.initial)
    .first<{ value: string }>();
  try {
    const v = row ? (JSON.parse(row.value) as Partial<InitialPass>) : {};
    return {
      done: v.done === true,
      cursor: typeof v.cursor === "string" ? v.cursor : null,
    };
  } catch {
    return { done: false, cursor: null };
  }
}

export const putInitial = (env: Env, p: InitialPass) =>
  putState(env, K.initial, JSON.stringify(p));

/** An unconfirmed connection is dropped this long after consent. */
export const CONFIRM_TTL_MS = 24 * 3600_000;

/** The consent waiting for confirmation: who connected, expiry, the count. */
export type PendingConfirm = {
  u: string;
  exp: number;
  count: number;
  capped: boolean;
  /** The consenting Google account (sub). */
  s?: string;
};

export async function readPending(env: Env): Promise<PendingConfirm | null> {
  const row = await stmt(
    env.DB,
    "select value from directory_state where key = ?",
  )
    .bind(K.confirm)
    .first<{ value: string }>();
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as Partial<PendingConfirm>;
    return typeof v.u === "string" && typeof v.exp === "number"
      ? {
          u: v.u,
          exp: v.exp,
          count: typeof v.count === "number" ? v.count : 0,
          capped: v.capped === true,
          ...(typeof v.s === "string" ? { s: v.s } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

/** Deletes only the pending binding, token and confirmation (the live connection stays). */
export const dropPending = (env: Env) =>
  stmt(env.DB, "delete from directory_state where key in (?, ?, ?)").bind(
    K.pendingBinding,
    K.pendingRefresh,
    K.confirm,
  );

/** The confirmation row is `uid`'s and unexpired (the confirm swap's gate). */
const OWNED = `exists (select 1 from directory_state where key = ?
  and json_extract(value, '$.u') = ? and json_extract(value, '$.exp') > ?)`;

const PROMOTE = `insert into directory_state (key, value)
  select ?, value from directory_state where key = ? and ${OWNED}
  on conflict (key) do update set value = excluded.value`;

/**
 * The confirm swap, in order for one D1 batch: the pending binding and
 * token become live, then the pending rows go, and last the confirmation
 * row (its `changes` says whether this confirm won). Every statement is
 * gated on the same owned, unexpired confirmation, so the batch swaps all
 * or nothing.
 */
export function promotePending(
  env: Env,
  uid: string,
  now: number,
): D1PreparedStatement[] {
  const gate = [K.confirm, uid, now];
  return [
    stmt(
      env.DB,
      `insert into directory_state (key, value)
        select ?, json_extract(value, '$.s') from directory_state
        where key = ? and json_extract(value, '$.s') is not null and ${OWNED}
        on conflict (key) do update set value = excluded.value`,
    ).bind(K.grantSub, K.confirm, ...gate),
    stmt(env.DB, PROMOTE).bind(K.binding, K.pendingBinding, ...gate),
    stmt(env.DB, PROMOTE).bind(K.refresh, K.pendingRefresh, ...gate),
    stmt(
      env.DB,
      `delete from directory_state where key in (?, ?) and ${OWNED}`,
    ).bind(K.pendingBinding, K.pendingRefresh, ...gate),
    stmt(
      env.DB,
      `delete from directory_state where key = ?
        and json_extract(value, '$.u') = ? and json_extract(value, '$.exp') > ?`,
    ).bind(...gate),
  ];
}

const EXPIRED = `exists (select 1 from directory_state
  where key = ? and json_extract(value, '$.exp') <= ?)`;

/**
 * Drops a pending confirmation past its 24 h (its pending binding and token
 * only; a live connection and its sync are untouched), with one
 * directory.connect audit row (actor system), then revokes the pending
 * grant at Google (best effort). A no-op otherwise. Called lazily by status
 * and confirm, and by the daily cron.
 */
export async function expirePending(
  env: Env,
  now = Date.now(),
): Promise<boolean> {
  const [{ sealed }, p] = await Promise.all([
    readBinding(env, "pending"),
    readPending(env),
  ]);
  const out = await env.DB.batch([
    audit(
      env,
      "directory.connect",
      { type: "directory", id: "google" },
      { kind: "system", id: null },
      {
        detail: { outcome: "expired" },
        when: { sql: EXPIRED, args: [K.confirm, now] },
      },
    ),
    stmt(
      env.DB,
      `delete from directory_state where key in (?, ?) and ${EXPIRED}`,
    ).bind(K.pendingBinding, K.pendingRefresh, K.confirm, now),
    stmt(
      env.DB,
      "delete from directory_state where key = ? and json_extract(value, '$.exp') <= ?",
    ).bind(K.confirm, now),
  ]);
  const expired = (out[2]?.meta.changes ?? 0) > 0;
  if (!expired) return false;
  logInfo("directory_connect", { outcome: "expired" });
  if (sealed)
    await revokeGrant(env, sealed, { kind: "system", id: null }, "pending", {
      sub: p?.s,
      keep: [await liveSub(env)],
    });
  return true;
}

/**
 * Revokes a grant no longer stored (an old live token after a confirm, a
 * pending one after cancel or expiry) at Google, best effort: a failure is
 * audited and logged, never surfaced.
 */
export async function revokeGrant(
  env: Env,
  sealed: string,
  actor: AuditActor,
  which: "old" | "pending",
  same: { sub: string | null | undefined; keep: (string | null)[] },
): Promise<boolean> {
  // Same Google account as a token that stays: revoking would end that one
  // too (Google revokes the whole grant). Unknown account: skip, fail safe.
  if (!same.sub || same.keep.includes(same.sub)) {
    await audit(
      env,
      "directory.connect",
      { type: "directory", id: "google" },
      actor,
      { detail: { outcome: "revoke_skipped", token: which } },
    )
      .run()
      .catch((e) => logWarn("directory_revoke_audit", e));
    return false;
  }
  let ok = false;
  try {
    const c = directoryClient(env);
    if (c) {
      await c.revoke(sealed);
      ok = true;
    }
  } catch (e) {
    logWarn("directory_revoke", e, { which });
  }
  await audit(
    env,
    "directory.connect",
    { type: "directory", id: "google" },
    actor,
    { detail: { outcome: ok ? "revoked" : "revoke_failed", token: which } },
  )
    .run()
    .catch((e) => logWarn("directory_revoke_audit", e));
  return ok;
}

/** The Google account behind the live token, or null. */
export async function liveSub(env: Env): Promise<string | null> {
  const row = await stmt(
    env.DB,
    "select value from directory_state where key = ?",
  )
    .bind(K.grantSub)
    .first<{ value: string }>();
  return row?.value ?? null;
}
