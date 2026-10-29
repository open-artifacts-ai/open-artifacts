import type { PlanLimit, PlanLimitDetails } from "@oa/shared";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { scopedPlan } from "./features.js";
import { billingOn } from "./plan.js";

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
    "FREE_STORAGE_BYTES" | "FREE_DATA_DOCS" | "FREE_DATA_DAILY_WRITES"
  >,
): FreeCaps => ({
  storage_bytes: positive(env.FREE_STORAGE_BYTES),
  data_docs: positive(env.FREE_DATA_DOCS),
  data_daily_writes: positive(env.FREE_DATA_DAILY_WRITES),
});

/** The caps that apply now: hosted, on the free tier; else null. */
export function activeFreeCaps(env: Env): FreeCaps | null {
  if (!billingOn(env) || scopedPlan()?.tier !== "free") return null;
  const caps = freeCapsOf(env);
  return Object.values(caps).some((v) => v !== null) ? caps : null;
}

/** 403 plan_limit for `limit` at `max`. */
export function planLimitError(limit: PlanLimit, max: number): ApiError {
  const details: PlanLimitDetails = { tier: "free", limit, max };
  return new ApiError(
    "plan_limit",
    "This free instance has reached its limit; a team plan lifts it",
    details,
  );
}

/**
 * The instance's stored content (Manager decision R5): every version of
 * every live (not trashed) artifact, history included, each distinct blob
 * once. A blob is its content digest (an inline file, hosted:
 * services/manifest.ts) or else its R2 key (an upload; a restore reuses
 * its keys). So republishing the same bytes adds nothing, and trashing an
 * artifact drops the blobs no live artifact still holds. One statement,
 * bounded by the cap itself (it runs only while the cap is on).
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
 */
export async function requireFreeData(
  env: Env,
  usage: () => Promise<CapUsage>,
  adds: boolean,
): Promise<void> {
  const caps = activeFreeCaps(env);
  if (!caps || (caps.data_docs === null && caps.data_daily_writes === null))
    return;
  const u = await usage();
  if (
    caps.data_daily_writes !== null &&
    u.writesToday >= caps.data_daily_writes
  )
    throw planLimitError("data_daily_writes", caps.data_daily_writes);
  if (adds && caps.data_docs !== null && !u.exists && u.docs >= caps.data_docs)
    throw planLimitError("data_docs", caps.data_docs);
}
