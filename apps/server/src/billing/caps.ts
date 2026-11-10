import type { PlanLimit, PlanLimitDetails } from "@oa/shared";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { scopedPlan } from "./features.js";
import { billingActive } from "./plan.js";

// Free-tier caps (hosted billing, Manager decision 1): configuration only,
// and NOT enforced until set. Each is a positive integer env var; unset,
// empty or invalid leaves that cap off. They apply only while the billing
// tier is free (this invocation's plan, withPlanScope), to everyone,
// the owner included:
// - FREE_STORAGE_BYTES: the instance's stored content: every version of
//   every live artifact, each distinct blob once, trash excluded
//   (STORED_BYTES). An upload that would pass it,
//   or a publish once it is reached, is 403 plan_limit.
// - FREE_DATA_DOCS: live-data docs per artifact. A write that would add a
//   doc past it is 403 plan_limit (updates and deletes of existing docs
//   pass).
// - FREE_DATA_DAILY_WRITES: live-data writes per artifact per UTC day,
//   below the instance's own DATA_DAILY_WRITES. Past it, 403 plan_limit.
// - FREE_DATA_DAILY_WRITES_TOTAL: live-data writes per install per UTC day,
//   across all artifacts (every write path: data, per-viewer storage and
//   the owner's reset). One D1 row (data_writes_total), bumped by the
//   write's own check, so no read or write happens while the cap is off.
//   Past it, 403 plan_limit. Viewer-level and anonymous writes are refused
//   once today's total reaches 80% of the cap (LOW_TRUST_SHARE), so they
//   cannot use up the day and lock out the owner's editors and agents, who
//   may write up to the full cap; max in the error is the bound that
//   applied. The count happens last, so a write the per-artifact caps refuse
//   is not counted, but a write refused after it (429, too_large, a bad
//   body) still counts.
// The checks run before the write (a soft cap: two concurrent writes at the
// edge may both pass).

export type FreeCaps = Record<PlanLimit, number | null>;

const positive = (raw: string | undefined): number | null => {
  const t = (raw ?? "").trim();
  if (!/^[1-9][0-9]{0,15}$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
};

/** The configured caps (null: that cap is off). */
export const freeCapsOf = (
  env: Pick<
    Env,
    | "FREE_STORAGE_BYTES"
    | "FREE_DATA_DOCS"
    | "FREE_DATA_DAILY_WRITES"
    | "FREE_DATA_DAILY_WRITES_TOTAL"
  >,
): FreeCaps => ({
  storage_bytes: positive(env.FREE_STORAGE_BYTES),
  data_docs: positive(env.FREE_DATA_DOCS),
  data_daily_writes: positive(env.FREE_DATA_DAILY_WRITES),
  data_daily_writes_total: positive(env.FREE_DATA_DAILY_WRITES_TOTAL),
});

/** The caps that apply now: hosted, on the solo (or transition free) tier; else null. */
export function activeFreeCaps(env: Env): FreeCaps | null {
  const tier = scopedPlan()?.tier;
  if (!billingActive(env) || (tier !== "free" && tier !== "solo")) return null;
  const caps = freeCapsOf(env);
  return Object.values(caps).some((v) => v !== null) ? caps : null;
}

/** 403 plan_limit for `limit` at `max`. */
export function planLimitError(limit: PlanLimit, max: number): ApiError {
  const details: PlanLimitDetails = { tier: "solo", limit, max };
  return new ApiError(
    "plan_limit",
    "This Solo instance has reached its limit. Delete what you no longer need, or ask the owner to move to a team plan.",
    details,
  );
}

/**
 * The instance's stored content (Manager decision R5): every version of
 * every live (not trashed) artifact, history included, each distinct blob
 * once. A blob is its recorded content digest (an inline file; an upload's
 * sha256 set by the PUT, R2-verified on any plan or hashed on paid;
 * services/manifest.ts), or else its R2 key (an upload without a digest, a
 * version from before digests; a restore reuses its keys). Digest-matched
 * bytes count once, and trashing an artifact drops the blobs no live artifact
 * still holds. One statement, bounded by the cap itself (it runs only while
 * the cap is on).
 */
const STORED_BYTES = `select coalesce(sum(size), 0) as n from (
  select max(json_extract(j.value, '$.size')) as size
  from artifacts a join versions v on v.artifact_id = a.id, json_each(v.manifest) j
  where a.deleted_at is null
  group by coalesce('d:' || json_extract(j.value, '$.digest'), 'k:' || json_extract(j.value, '$.key'))
)`;

/** The instance's stored content bytes (STORED_BYTES). */
export async function storedBytes(env: Env): Promise<number> {
  const r = await env.DB.prepare(STORED_BYTES).first<{ n: number }>();
  return r?.n ?? 0;
}

/**
 * FREE_STORAGE_BYTES: refuses `adding` more bytes when the instance's
 * stored bytes plus `adding` would pass the cap (a publish passes 1: it is
 * refused once the cap is reached).
 */
export async function requireFreeStorage(
  env: Env,
  adding: number,
): Promise<void> {
  const max = activeFreeCaps(env)?.storage_bytes ?? null;
  if (max === null) return;
  if ((await storedBytes(env)) + adding > max)
    throw planLimitError("storage_bytes", max);
}

/** The DO's numbers the data caps need (ArtifactRuntime.capUsage). */
export type CapUsage = { docs: number; writesToday: number; exists: boolean };

/**
 * FREE_DATA_DOCS and FREE_DATA_DAILY_WRITES for one data write. `usage`
 * reads the DO (only called when a cap is on). `adds`: the write may create
 * the doc (set, update); a delete never counts against the doc cap.
 * `lowTrust`: a viewer-level or anonymous writer (no creator), held to 80%
 * of FREE_DATA_DAILY_WRITES_TOTAL.
 */
export async function requireFreeData(
  env: Env,
  usage: () => Promise<CapUsage>,
  adds: boolean,
  lowTrust = false,
): Promise<void> {
  const caps = activeFreeCaps(env);
  if (!caps) return;
  if (caps.data_docs !== null || caps.data_daily_writes !== null) {
    const u = await usage();
    if (
      caps.data_daily_writes !== null &&
      u.writesToday >= caps.data_daily_writes
    )
      throw planLimitError("data_daily_writes", caps.data_daily_writes);
    if (
      adds &&
      caps.data_docs !== null &&
      !u.exists &&
      u.docs >= caps.data_docs
    )
      throw planLimitError("data_docs", caps.data_docs);
  }
  // Last, so a write the per-artifact caps refuse is not counted here.
  if (caps.data_daily_writes_total !== null)
    await countTotalWrite(env, caps.data_daily_writes_total, lowTrust);
}

/** The share of the install-wide total viewer-level and anonymous writes may use. */
const LOW_TRUST_SHARE = 0.8;

/**
 * FREE_DATA_DAILY_WRITES_TOTAL: counts one write against today's install-wide
 * total, or refuses it at `max`. One atomic statement: the upsert bumps the
 * row (restarting it on a new UTC day) only while under `max`, and returns
 * nothing when it did not.
 */
async function countTotalWrite(
  env: Env,
  cap: number,
  lowTrust: boolean,
): Promise<void> {
  const max = lowTrust ? Math.floor(cap * LOW_TRUST_SHARE) : cap;
  if (max < 1) throw planLimitError("data_daily_writes_total", max || cap);
  const day = Math.floor(Date.now() / 86_400_000);
  const r = await env.DB.prepare(
    `insert into data_writes_total (id, day, n) values (1, ?1, 1)
     on conflict(id) do update set
       n = case when day = ?1 then n + 1 else 1 end, day = ?1
     where day <> ?1 or n < ?2
     returning n`,
  )
    .bind(day, max)
    .first<{ n: number }>();
  if (!r) throw planLimitError("data_daily_writes_total", max);
}
