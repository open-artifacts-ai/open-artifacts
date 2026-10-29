import type { Env } from "../env.js";
import { logInfo, logWarn } from "../log.js";
import { revokeFanoutCap, revokeUsersLive } from "../runtime/revoke.js";
import {
  billingOn,
  CHECK_KEY,
  effectivePlan,
  PLAN_KEY,
  PlanCheckSchema,
  parseStored,
  type StoredPlan,
  TierAnswerSchema,
} from "./plan.js";
import {
  BillingUnavailableError,
  billingCall,
  TIER_PATH,
  TRIAL_PATH,
} from "./transport.js";

type Ctx = Pick<ExecutionContext, "waitUntil"> | undefined;

/** On demand (not the scheduler tick), GET /tier runs at most this often. */
export const ON_DEMAND_MS = 60_000;

/**
 * The cached answer, only when it is newer: a higher version, or the same
 * version read later (asOf). An older version never replaces a newer one,
 * whatever order two reads land in. RETURNING says whether it applied.
 */
const STORE_PLAN = `insert into settings (key, value) values ('${PLAN_KEY}', ?1)
  on conflict (key) do update set value = excluded.value
  where coalesce(json_extract(settings.value, '$.version'), -1) < json_extract(excluded.value, '$.version')
     or (coalesce(json_extract(settings.value, '$.version'), -1) = json_extract(excluded.value, '$.version')
         and coalesce(json_extract(settings.value, '$.asOf'), 0) < json_extract(excluded.value, '$.asOf'))
  returning value`;

const READ_BOTH = `select
  (select value from settings where key = '${PLAN_KEY}') as plan,
  (select value from settings where key = '${CHECK_KEY}') as "check"`;

/** A good read: the attempt time, and no failure run. */
const CHECK_OK = `insert into settings (key, value) values ('${CHECK_KEY}', json_object('checkedAt', ?1, 'failingSince', null))
  on conflict (key) do update set value = excluded.value`;
/** A failed read: the attempt time; the run's start kept, or set now. */
const CHECK_FAIL = `insert into settings (key, value) values ('${CHECK_KEY}', json_object('checkedAt', ?1, 'failingSince', ?1))
  on conflict (key) do update set value = json_object('checkedAt', ?1,
    'failingSince', coalesce(json_extract(settings.value, '$.failingSince'), ?1))`;
/**
 * The on-demand claim: one read per ON_DEMAND_MS across the instance. Takes
 * the slot only when the last attempt is older than ?2; RETURNING says
 * whether this call got it.
 */
const CLAIM = `insert into settings (key, value) values ('${CHECK_KEY}', json_object('checkedAt', ?1, 'failingSince', null))
  on conflict (key) do update set value = json_set(settings.value, '$.checkedAt', ?1)
  where coalesce(json_extract(settings.value, '$.checkedAt'), 0) <= ?2
  returning key`;

/** Every active user but the org owner, most recently seen first (the plan cap's reach). */
const CAPPED_USERS = `select id from users where status = 'active' and role != 'owner'
  order by last_seen_at desc limit ?1`;

/**
 * Stores a GET /tier (or /trial/start) answer under the version rule. When
 * it moves the instance into a lock (solo or read-only), everyone but the
 * owner just got the plan cap: their live sockets close (revokeUsersLive),
 * as for any narrowing. Returns whether the answer was newer and applied.
 */
export async function storePlan(
  env: Env,
  answer: StoredPlan,
  now: number,
  ctx?: Ctx,
): Promise<boolean> {
  const before = await env.DB.prepare(READ_BOTH).first<{
    plan: string | null;
    check: string | null;
  }>();
  const prev = effectivePlan(
    parseStored(TierAnswerSchema, before?.plan),
    parseStored(PlanCheckSchema, before?.check),
    env.TIER,
    now,
  );
  const [stored] = await env.DB.batch([
    env.DB.prepare(STORE_PLAN).bind(JSON.stringify(answer)),
    env.DB.prepare(CHECK_OK).bind(now),
  ]);
  const applied = (stored?.results.length ?? 0) > 0;
  if (!applied) return false;
  const next = effectivePlan(answer, null, env.TIER, now);
  if (next.lock && !prev.lock) {
    logInfo("billing_plan_locked", { reason: next.lock.reason });
    const { results } = await env.DB.prepare(CAPPED_USERS)
      .bind(revokeFanoutCap(env) + 1)
      .all<{ id: string }>();
    await revokeUsersLive(
      env,
      results.map((r) => r.id),
      "plan locked",
      ctx,
    );
  }
  return true;
}

/** Records a failed read (the 7-day clock starts at the first one). */
export async function recordFailure(env: Env, now: number): Promise<void> {
  await env.DB.prepare(CHECK_FAIL).bind(now).run();
}

/**
 * GET /tier and cache it. `onDemand`: at most once per ON_DEMAND_MS across
 * the instance (the claim); the scheduler tick always reads. Never throws:
 * a failure is recorded and logged by category.
 */
export async function refreshPlan(
  env: Env,
  now: number,
  o: { onDemand?: boolean; ctx?: Ctx } = {},
): Promise<"stored" | "unchanged" | "skipped" | "failed"> {
  if (!billingOn(env)) return "skipped";
  try {
    if (o.onDemand) {
      const claimed = await env.DB.prepare(CLAIM)
        .bind(now, now - ON_DEMAND_MS)
        .first();
      if (!claimed) return "skipped";
    }
    const raw = await billingCall(env, TIER_PATH, null, now);
    const r = TierAnswerSchema.safeParse(raw);
    if (!r.success) throw new BillingUnavailableError("bad_answer");
    return (await storePlan(env, r.data, now, o.ctx)) ? "stored" : "unchanged";
  } catch (e) {
    const why = e instanceof BillingUnavailableError ? e.why : "error";
    logWarn("billing_tier_failed", undefined, { why });
    try {
      await recordFailure(env, now);
    } catch {
      // D1 down too: the next read records it.
    }
    return "failed";
  }
}

/**
 * Signed POST /trial/start (idempotent: billing starts a trial once, from
 * free and active only) and cache the answer. Never throws; on failure the
 * scheduler tick retries while the instance is free with members.
 */
export async function startTrial(
  env: Env,
  now: number,
  ctx?: Ctx,
): Promise<boolean> {
  if (!billingOn(env)) return false;
  try {
    const raw = await billingCall(env, TRIAL_PATH, {}, now);
    const r = TierAnswerSchema.safeParse(raw);
    if (!r.success) throw new BillingUnavailableError("bad_answer");
    await storePlan(env, r.data, now, ctx);
    logInfo("billing_trial", { tier: r.data.tier });
    return r.data.tier === "trial";
  } catch (e) {
    const why = e instanceof BillingUnavailableError ? e.why : "error";
    logWarn("billing_trial_failed", undefined, { why });
    return false;
  }
}

/** Free, the trial never started, and someone besides the owner is here: the tick retries the trial. */
const TRIAL_PENDING = `select 1 from users where status = 'active' and role != 'owner' limit 1`;

/**
 * The scheduler tick's billing step: read the tier; when the instance is
 * still free and trial-eligible but already has a member besides the owner
 * (the invite's trial start failed), start the trial again.
 */
export async function billingTick(env: Env, now: number): Promise<void> {
  if (!billingOn(env)) return;
  await refreshPlan(env, now);
  const row = await env.DB.prepare(READ_BOTH).first<{
    plan: string | null;
    check: string | null;
  }>();
  const plan = effectivePlan(
    parseStored(TierAnswerSchema, row?.plan),
    parseStored(PlanCheckSchema, row?.check),
    env.TIER,
    now,
  );
  if (plan.trialEligible && (await env.DB.prepare(TRIAL_PENDING).first()))
    await startTrial(env, now);
}
