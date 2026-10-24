import { type DirectoryBinding, DirectoryBindingSchema } from "@oa/shared";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { logInfo } from "../log.js";
import { audit } from "../services/audit.js";

// The directory connection at rest, in P3's directory_state key/value table
// (no migration; T13's DirectorySync reads the same rows):
// - "binding": the DirectoryBinding JSON;
// - "refresh": the sealed refresh token (crypto.ts), never plaintext;
// - "connect.pending": the one connect in flight, {h: sha256(state), u, exp},
//   consumed by its callback (single use);
// - "connect.confirm": a consent waiting for its owner, {u, exp, count,
//   capped}; T13 must not sync while it exists;
// - "binding.initial": the initial binding pass, {done, cursor} (T13
//   continues a pass whose cursor is set).

export const K = {
  binding: "binding",
  refresh: "refresh",
  pending: "connect.pending",
  confirm: "connect.confirm",
  initial: "binding.initial",
} as const;

export const UPSERT = `insert into directory_state (key, value) values (?, ?)
  on conflict (key) do update set value = excluded.value`;

export const putState = (env: Env, key: string, value: string) =>
  stmt(env.DB, UPSERT).bind(key, value);

const READ = "select key, value from directory_state where key in (?, ?)";

/** The binding and the sealed refresh token, in one statement. */
export async function readBinding(
  env: Env,
): Promise<{ binding: DirectoryBinding | null; sealed: string | null }> {
  const { results } = await stmt(env.DB, READ)
    .bind(K.binding, K.refresh)
    .all<{ key: string; value: string }>();
  let binding: DirectoryBinding | null = null;
  let sealed: string | null = null;
  for (const r of results) {
    if (r.key === K.refresh) sealed = r.value;
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
        }
      : null;
  } catch {
    return null;
  }
}

/** Deletes the stored token, binding and pending confirmation. */
export const dropConnection = (env: Env) =>
  stmt(env.DB, "delete from directory_state where key in (?, ?, ?)").bind(
    K.binding,
    K.refresh,
    K.confirm,
  );

const EXPIRED = `exists (select 1 from directory_state
  where key = ? and json_extract(value, '$.exp') <= ?)`;

/**
 * Drops a pending confirmation past its 24 h (token and binding included),
 * with one directory.connect audit row (actor system). A no-op otherwise.
 * Called lazily by status and confirm, and by the daily cron.
 */
export async function expirePending(
  env: Env,
  now = Date.now(),
): Promise<boolean> {
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
    ).bind(K.binding, K.refresh, K.confirm, now),
    stmt(
      env.DB,
      "delete from directory_state where key = ? and json_extract(value, '$.exp') <= ?",
    ).bind(K.confirm, now),
  ]);
  const expired = (out[2]?.meta.changes ?? 0) > 0;
  if (expired) logInfo("directory_connect", { outcome: "expired" });
  return expired;
}
