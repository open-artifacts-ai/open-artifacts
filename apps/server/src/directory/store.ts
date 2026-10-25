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

/**
 * The confirm swap, in order for one D1 batch: the pending binding and
 * token become live, then the pending rows go, and last the confirmation
 * row (its `changes` says whether this confirm won). Every statement is
 * gated on the same owned, unexpired confirmation AND on the pending rows
 * still holding exactly the values confirm read (`seen`), so a second
 * callback landing in between promotes nothing (D1 has no SHA function;
 * exact equality is the stronger form of the hash check). The batch swaps
 * all or nothing. A pending consent without a Google account clears
 * grant.sub, so a later revoke never compares against a stale account.
 */
export function promotePending(
  env: Env,
  uid: string,
  now: number,
  seen: { binding: string; refresh: string },
): D1PreparedStatement[] {
  const gated = `${OWNED} and ${SEEN}`;
  const gate = [
    K.confirm,
    uid,
    now,
    K.pendingBinding,
    seen.binding,
    K.pendingRefresh,
    seen.refresh,
  ];
  const promote = `insert into directory_state (key, value)
    select ?, value from directory_state where key = ? and ${gated}
    on conflict (key) do update set value = excluded.value`;
  return [
    stmt(
      env.DB,
      `delete from directory_state where key = ? and exists (
        select 1 from directory_state where key = ?
          and json_extract(value, '$.s') is null) and ${gated}`,
    ).bind(K.grantSub, K.confirm, ...gate),
    stmt(
      env.DB,
      `insert into directory_state (key, value)
        select ?, json_extract(value, '$.s') from directory_state
        where key = ? and json_extract(value, '$.s') is not null and ${gated}
        on conflict (key) do update set value = excluded.value`,
    ).bind(K.grantSub, K.confirm, ...gate),
    stmt(env.DB, promote).bind(K.binding, K.pendingBinding, ...gate),
    stmt(env.DB, promote).bind(K.refresh, K.pendingRefresh, ...gate),
    // The confirmation row goes last of the gated statements: its `changes`
    // says whether this confirm won (CONFIRM_WON).
    stmt(
      env.DB,
      `delete from directory_state where key = ?
        and json_extract(value, '$.u') = ? and json_extract(value, '$.exp') > ?
        and ${SEEN}`,
    ).bind(...gate),
    // Then the pending rows, only if it did (changes() of the statement just
    // before; a gate re-reading the rows being deleted would see half gone).
    stmt(
      env.DB,
      "delete from directory_state where key in (?, ?) and changes() > 0",
    ).bind(K.pendingBinding, K.pendingRefresh),
  ];
}

/** Index in promotePending's statements of the confirmation-row delete. */
export const CONFIRM_WON = 4;

/** The pending rows still hold the values confirm read. */
const SEEN = `exists (select 1 from directory_state where key = ? and value = ?)
  and exists (select 1 from directory_state where key = ? and value = ?)`;

/** The raw pending binding and token, as stored (the confirm gate's `seen`). */
export async function readPendingRaw(
  env: Env,
): Promise<{ binding: string; refresh: string } | null> {
  const { results } = await stmt(env.DB, READ)
    .bind(K.pendingBinding, K.pendingRefresh)
    .all<{ key: string; value: string }>();
  const get = (k: string) => results.find((r) => r.key === k)?.value;
  const binding = get(K.pendingBinding);
  const refresh = get(K.pendingRefresh);
  return binding && refresh ? { binding, refresh } : null;
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
  const ok = await revokeAtGoogle(env, sealed, which);
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

/**
 * One revoke of the grant behind `sealed` at Google, through this install's
 * transport (broker or direct). Never throws: false when it failed or no
 * transport is configured (logged).
 */
export async function revokeAtGoogle(
  env: Env,
  sealed: string,
  which: "old" | "pending" | "live",
): Promise<boolean> {
  try {
    const c = directoryClient(env);
    if (!c) return false;
    await c.revoke(sealed);
    return true;
  } catch (e) {
    logWarn("directory_revoke", e, { which });
    return false;
  }
}

/**
 * Every directory_state key (binding, tokens, pending consent, grant.sub,
 * the initial pass, health and sync.state), returning what it deleted. One
 * exception: sync.state = customer_mismatch stays as a tombstone, so synced
 * users stay denied after a disconnect (health.ts MISMATCH_TOMBSTONE).
 */
export const wipeState = (env: Env) =>
  stmt(
    env.DB,
    `delete from directory_state
      where not (key = 'sync.state' and value = 'customer_mismatch')
      returning key, value`,
  );

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
