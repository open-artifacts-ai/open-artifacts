import type { HeldSweep, InstanceDirectory, SyncState } from "@oa/shared";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { UPSERT } from "./store.js";

// Directory sync health at rest (P3 T13), in directory_state next to T12's
// binding rows, so every reader (R.directory, Me.instance.directory, and
// T18's getUser check) reads D1 and never waits on the DirectorySync DO:
// - "sync.health": the Health JSON below, written by DirectorySync only
//   when it changes;
// - "sync.state": the SyncState alone, so T18's per-request denial for
//   customer_mismatch is one primary-key probe.

export const HK = { health: "sync.health", state: "sync.state" } as const;

/** Unhealthy this long: the banner and the 24 h browser session cap (T18). */
export const BANNER_AFTER_MS = 3600_000;
/** Unhealthy this long: one email to the owners per outage. */
export const ALERT_AFTER_MS = 24 * 3600_000;
/**
 * lastSuccessAt + this is staleAt (T18). Informational only: access is
 * unchanged when stale (no stale cutoff); it only decides when staleAt is
 * reported and the one directory.stale audit row.
 */
export const STALE_MS = 7 * 86_400_000;

export type Health = {
  state: Exclude<SyncState, "pending_confirm">;
  unhealthySince: number | null;
  lastSuccessAt: number | null;
  lastError: { at: number; message: string } | null;
  nextRunAt: number | null;
  alertedAt: number | null;
  customerMismatch: { expected: string; actual: string } | null;
  held: HeldSweep[];
  /** Consecutive backoff failures (the delay doubles from 2 to 30 min). */
  backoffN: number;
  /** The failing state of the current outage (audited once on entry), else null. */
  failState: SyncState | null;
  /**
   * Each lane's failing state, else null. Healthy only when both are null:
   * the fast lane's success never hides a failing reconcile.
   */
  lanes: { fast: SyncState | null; rec: SyncState | null };
  /**
   * lastSuccessAt + STALE_MS, set (and audited directory.stale) by the first
   * failing alarm past it; null again on success. Informational (T18).
   */
  staleAt: number | null;
};

export const NEVER: Health = {
  state: "never",
  unhealthySince: null,
  lastSuccessAt: null,
  lastError: null,
  nextRunAt: null,
  alertedAt: null,
  customerMismatch: null,
  held: [],
  backoffN: 0,
  failState: null,
  lanes: { fast: null, rec: null },
  staleAt: null,
};

/**
 * `h` with staleAt marked when it is past lastSuccessAt + STALE_MS and not
 * yet marked; `became` is true exactly once per outage (the directory.stale
 * audit row). It revokes nothing.
 */
export function markStale(
  h: Health,
  now: number,
): { h: Health; became: boolean } {
  if (h.staleAt !== null || h.lastSuccessAt === null)
    return { h, became: false };
  const at = h.lastSuccessAt + STALE_MS;
  return at <= now
    ? { h: { ...h, staleAt: at }, became: true }
    : { h, became: false };
}

/** When `h` is (or became) stale: the stored mark, else lastSuccessAt + STALE_MS once past. */
export function staleAtOf(h: Health, now = Date.now()): number | null {
  if (h.staleAt !== null) return h.staleAt;
  if (h.lastSuccessAt === null) return null;
  const at = h.lastSuccessAt + STALE_MS;
  return at <= now ? at : null;
}

const READ = "select value from directory_state where key = ?";

export async function readHealth(env: Pick<Env, "DB">): Promise<Health> {
  const row = await stmt(env.DB, READ)
    .bind(HK.health)
    .first<{ value: string }>();
  if (!row) return NEVER;
  try {
    const v = JSON.parse(row.value) as Partial<Health>;
    return {
      ...NEVER,
      ...v,
      held: Array.isArray(v.held) ? v.held : [],
      lanes: { ...NEVER.lanes, ...(v.lanes ?? {}) },
    };
  } catch {
    return NEVER;
  }
}

/**
 * The statements writing `next` over `prev`: none when unchanged; the bare
 * state only when it changed.
 */
export const putHealth = (
  env: Pick<Env, "DB">,
  prev: Health,
  next: Health,
): D1PreparedStatement[] =>
  JSON.stringify(prev) === JSON.stringify(next)
    ? []
    : [
        stmt(env.DB, UPSERT).bind(HK.health, JSON.stringify(next)),
        ...(prev.state === next.state
          ? []
          : [stmt(env.DB, UPSERT).bind(HK.state, next.state)]),
      ];

/** Drops the health rows (directory disconnected). */
export const clearHealth = (env: Pick<Env, "DB">) =>
  stmt(
    env.DB,
    `delete from directory_state where key = ?1 or (key = ?2 and (
      value <> 'customer_mismatch'
      or exists (select 1 from directory_state where key = 'binding')))
      or (key = 'binding.prior'
        and exists (select 1 from directory_state where key = 'binding'))`,
  ).bind(HK.health, HK.state);

/**
 * A disconnect during customer_mismatch keeps sync.state as this tombstone
 * (no binding): synced users stay denied (fail closed). clearHealth keeps it
 * too; only a new live binding (the owner's break-glass reconnect and
 * confirm, whose resetSync clears health) lifts it.
 */
export const MISMATCH_TOMBSTONE = "customer_mismatch";

/** The bare sync.state row, or null. */
export async function readSyncState(
  env: Pick<Env, "DB">,
): Promise<string | null> {
  const row = await stmt(env.DB, READ)
    .bind(HK.state)
    .first<{ value: string }>();
  return row?.value ?? null;
}

const iso = (n: number | null) =>
  n === null ? null : new Date(n).toISOString();

/** The SyncStatus fields that come from health. */
export function healthFields(h: Health, now = Date.now()) {
  return {
    healthy: h.state === "ok",
    unhealthySince: iso(h.unhealthySince),
    lastSuccessAt: iso(h.lastSuccessAt),
    lastError: h.lastError
      ? {
          at: new Date(h.lastError.at).toISOString(),
          message: h.lastError.message,
        }
      : null,
    nextRunAt: iso(h.nextRunAt),
    staleAt: iso(staleAtOf(h, now)),
    alertedAt: iso(h.alertedAt),
    customerMismatch: h.customerMismatch,
    held: h.held,
  };
}

/**
 * Me.instance.directory. Health (banner, state, staleAt, held sweeps) is
 * for org owners and admins only; everyone else reads the mode alone.
 */
export function instanceDirectory(
  mode: InstanceDirectory["mode"],
  h: Health,
  admin: boolean,
  now = Date.now(),
): InstanceDirectory {
  if (mode === "off" || !admin)
    return {
      mode,
      healthy: null,
      unhealthySince: null,
      banner: false,
      tokensUnverified: false,
      state: null,
      staleAt: null,
      heldSweeps: 0,
    };
  const f = healthFields(h, now);
  const unhealthy = h.unhealthySince !== null;
  return {
    mode,
    healthy: f.healthy,
    unhealthySince: f.unhealthySince,
    banner: unhealthy && now - (h.unhealthySince ?? now) >= BANNER_AFTER_MS,
    tokensUnverified: unhealthy,
    state: h.state,
    staleAt: f.staleAt,
    heldSweeps: h.held.length,
  };
}
