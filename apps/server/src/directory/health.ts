import type {
  HeldSweep,
  InstanceDirectory,
  LiftPaused,
  SyncState,
} from "@oa/shared";
import { stmt } from "../db/stmt.js";
import type { Env } from "../env.js";
import { CONNECTED_KEYS, UPSERT } from "./store.js";

// Directory sync health at rest (P3 T13), in directory_state next to T12's
// binding rows, so every reader (R.directory, Me.instance.directory, and
// T18's getUser check) reads D1 and never waits on the DirectorySync DO:
// - "sync.health": the Health JSON below, written by DirectorySync only
//   when it changes;
// - "sync.state": the SyncState alone, so T18's per-request denial for
//   customer_mismatch is one primary-key probe.

export const HK = {
  health: "sync.health",
  state: "sync.state",
  /** The reconcile run (its startedAt, ms) whose thaw had frozen edits to apply: lastThaw's id (#2150). */
  thaw: "sync.thaw",
} as const;

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
  /**
   * Restricted groups that blocked the last reconcile's lift (RESTRICTED_ALL
   * lowers nobody until every restricted group is read whole).
   */
  liftsPaused: LiftPaused[];
  /** Lifts paused without a break since; null while they run. */
  liftsPausedSince: number | null;
  /** The owner alert for the current pause (once per pause), else null. */
  liftsAlertedAt: number | null;
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
  liftsPaused: [],
  liftsPausedSince: null,
  liftsAlertedAt: null,
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
  return (await readHealthRaw(env)).h;
}

/** Health and the stored JSON it came from (null: no row), for a compare-and-set. */
export async function readHealthRaw(
  env: Pick<Env, "DB">,
): Promise<{ h: Health; raw: string | null }> {
  const row = await stmt(env.DB, READ)
    .bind(HK.health)
    .first<{ value: string }>();
  return parseHealth(row?.value ?? null);
}

function parseHealth(raw: string | null): { h: Health; raw: string | null } {
  if (raw === null) return { h: NEVER, raw: null };
  try {
    const v = JSON.parse(raw) as Partial<Health>;
    return {
      h: {
        ...NEVER,
        ...v,
        held: Array.isArray(v.held) ? v.held : [],
        liftsPaused: Array.isArray(v.liftsPaused) ? v.liftsPaused : [],
        lanes: { ...NEVER.lanes, ...(v.lanes ?? {}) },
      },
      raw,
    };
  } catch {
    return { h: NEVER, raw };
  }
}

/**
 * Health and whether a directory is connected (any CONNECTED key), in the one D1 statement /me
 * already spends on health (both are directory_state rows): no extra read.
 */
export async function readHealthBound(
  env: Pick<Env, "DB">,
): Promise<{ h: Health; bound: boolean }> {
  const { results } = await stmt(
    env.DB,
    `select key, value from directory_state where key in (?, ${CONNECTED_KEYS.map(() => "?").join(", ")})`,
  )
    .bind(HK.health, ...CONNECTED_KEYS)
    .all<{ key: string; value: string }>();
  let health: string | null = null;
  let bound = false;
  for (const r of results) {
    if (r.key === HK.health) health = r.value;
    else bound = true;
  }
  return { h: parseHealth(health).h, bound };
}

/**
 * The health JSON replaced only while it is still `?3` (what the writer
 * read): changes 0 when another write (an alarm's, a reset's clear) landed
 * in between.
 */
export const HEALTH_CAS =
  "update directory_state set value = ?1 where key = ?2 and value = ?3";

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

/**
 * Drops the health rows (a reset). The customer_mismatch tombstone goes only
 * once a new binding is live and no tenant change still owes retiring the
 * previous Workspace's users (binding.ts retireTenant).
 */
export const clearHealth = (env: Pick<Env, "DB">) =>
  stmt(
    env.DB,
    `delete from directory_state where key = ?1 or (key = ?2 and (
      value <> 'customer_mismatch'
      or (exists (select 1 from directory_state where key = 'binding')
        and not exists (select 1 from directory_state where key = 'tenant.retire'))))
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

/** Snoozed at `now` (#412): until is still ahead. */
const snoozedAt = (x: HeldSweep, now: number) =>
  !!x.snoozedUntil && Date.parse(x.snoozedUntil) > now;

/**
 * The held list as readers see it: a snooze whose `until` passed shows as
 * none even before the next alarm ends it (and an entry from before #412
 * gets the snooze fields).
 */
export const heldAt = (held: HeldSweep[], now: number): HeldSweep[] =>
  held.map((x) =>
    snoozedAt(x, now) ? x : { ...x, snoozedUntil: null, snoozeReason: null },
  );

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
    held: heldAt(h.held, now),
    liftsPaused: h.liftsPaused,
  };
}

export type ThawNotice = Pick<InstanceDirectory, "pendingReverts" | "lastThaw">;

/** How long after a thaw its notice stays on /me. */
export const THAW_NOTICE_MS = 3 * 86_400_000;
const THAW_REVERTS =
  "('space.member.role', 'space.member.remove', 'space.member.add')";

/**
 * For owners and admins (#2150), one or two cheap reads:
 * - frozen: pendingReverts, the people (not removed) the thaw would audit as
 *   a revert, by thaw.ts AUDITS 0-2: an override edit whose pre-freeze manual
 *   role (none: null) differs from the manual row now (so a role changed back
 *   by hand counts nobody). Removals and manual adds stay, and so does a pair
 *   no current mapping gives a role (the thaw keeps its manual row, #2282).
 * - google: lastThaw, from the thaw's audit rows (actor sync, detail thaw
 *   true, the role, remove and add outcomes) at or after the thaw's own start
 *   marker (HK.thaw, written when a reconcile's thaw step has frozen edits),
 *   within 3 days. The marker is the id, so each thaw has its own.
 */
export async function readThawNotice(
  env: Pick<Env, "DB">,
  mode: InstanceDirectory["mode"],
  now = Date.now(),
): Promise<ThawNotice> {
  if (mode === "frozen") {
    const r = await stmt(
      env.DB,
      `select count(distinct f.user_id) as n from frozen_edits f
        join users u on u.id = f.user_id
        where f.kind = 'override' and u.status <> 'removed'
          and exists (select 1 from group_mappings gm join directory_members dm
            on dm.group_id = gm.group_id
            where gm.space_id = f.space_id and dm.user_id = f.user_id) and (
          (f.manual_role is null and exists (select 1 from space_members m
            where m.space_id = f.space_id and m.user_id = f.user_id and m.source = 'manual'))
          or (f.manual_role is not null and not exists (select 1 from space_members m
            where m.space_id = f.space_id and m.user_id = f.user_id and m.source = 'manual'
              and m.role = f.manual_role)))`,
    ).first<{ n: number }>();
    return { pendingReverts: r?.n ?? 0 };
  }
  if (mode !== "google") return {};
  const since = now - THAW_NOTICE_MS;
  const where = `from audit_events a join users u on u.id = a.target_id
    where a.at >= ?1 and a.at >= (select cast(value as integer) from directory_state where key = ?2)
      and a.actor_kind = 'sync' and a.action in ${THAW_REVERTS}
      and json_extract(a.detail, '$.thaw') = 1 and u.status <> 'removed'`;
  const r = await stmt(
    env.DB,
    `select count(distinct a.target_id) as n, max(a.at) as last, (select value from directory_state where key = ?2) as id ${where}`,
  )
    .bind(since, HK.thaw)
    .first<{ n: number; last: number | null; id: string | null }>();
  if (!r?.n || r.last === null || r.id === null) return {};
  const { results } = await stmt(
    env.DB,
    `select u.name, u.email ${where} group by a.target_id order by min(a.at), a.target_id limit 2`,
  )
    .bind(since, HK.thaw)
    .all<{ name: string; email: string }>();
  return {
    lastThaw: {
      id: r.id,
      reverted: r.n,
      names: results.map((x) => x.name.trim() || x.email),
      at: new Date(r.last).toISOString(),
    },
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
  /** A directory is connected (live or pending); set for owners and admins only. */
  bound?: boolean,
  /** pendingReverts and lastThaw (readThawNotice); owners and admins only. */
  thaw: ThawNotice = {},
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
    ...(bound === undefined ? {} : { bound }),
    ...thaw,
    staleAt: f.staleAt,
    // A snoozed hold doesn't light the Settings dot (#412).
    heldSweeps: h.held.filter((x) => !snoozedAt(x, now)).length,
  };
}
