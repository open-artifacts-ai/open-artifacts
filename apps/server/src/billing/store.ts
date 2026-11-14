import { type AuditAction, parseTier } from "@oa/shared";
import type { Env } from "../env.js";
import { logInfo, logWarn } from "../log.js";
import { revokeFanoutCap, revokeUsersLive } from "../runtime/revoke.js";
import { audit } from "../services/audit.js";
import { LIVE_KEY, monthOf } from "./creators.js";
import {
  billingActive,
  CHECK_KEY,
  effectivePlan,
  PLAN_KEY,
  parseStored,
  planOfRaw,
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

/**
 * A good read (of any version, applied or not): the attempt time, no
 * failure run, and lastGoodAt (the 7-day clock's start).
 */
const CHECK_OK = `insert into settings (key, value) values ('${CHECK_KEY}', json_object('checkedAt', ?1, 'failingSince', null, 'lastGoodAt', ?1))
  on conflict (key) do update set value = excluded.value`;
/** A failed read: the attempt time; the run's start and lastGoodAt kept, or set now. */
const CHECK_FAIL = `insert into settings (key, value) values ('${CHECK_KEY}', json_object('checkedAt', ?1, 'failingSince', ?1, 'lastGoodAt', null))
  on conflict (key) do update set value = json_object('checkedAt', ?1,
    'failingSince', coalesce(json_extract(settings.value, '$.failingSince'), ?1),
    'lastGoodAt', json_extract(settings.value, '$.lastGoodAt'))`;
/**
 * The on-demand claim: one read per ON_DEMAND_MS across the instance. Takes
 * the slot only when the last attempt is older than ?2; RETURNING says
 * whether this call got it.
 */
const CLAIM = `insert into settings (key, value) values ('${CHECK_KEY}', json_object('checkedAt', ?1, 'failingSince', null, 'lastGoodAt', null))
  on conflict (key) do update set value = json_set(settings.value, '$.checkedAt', ?1)
  where coalesce(json_extract(settings.value, '$.checkedAt'), 0) <= ?2
  returning key`;

/** Every active user but the org owner, most recently seen first (the plan cap's reach). */
const CAPPED_USERS = `select id from users where status = 'active' and role != 'owner'
  order by last_seen_at desc limit ?1`;

/**
 * The plan-change audit rows (#2458) for an answer replacing `last` (null: the
 * provisioned TIER is the baseline), each only while STORE_PLAN changed a row
 * (`changes() > 0`, so an unapplied answer writes none). Both sides are read
 * raw (now 0: no trial-expiry or staleness view), so a trial that ran out
 * and is now answered solo still records the move. Ids and enums only: no
 * Stripe id, amount or address. Never throws: a failure here must not stop
 * the plan from being stored.
 */
function planAudits(
  env: Env,
  last: StoredPlan | null,
  answer: StoredPlan,
): D1PreparedStatement[] {
  try {
    const prev = effectivePlan(last, null, env.TIER, 0);
    const next = effectivePlan(answer, null, env.TIER, 0);
    const out: [AuditAction, Record<string, unknown>][] = [];
    if (prev.tier !== next.tier)
      out.push([
        "plan.change",
        {
          from: prev.tier,
          to: next.tier,
          ...(next.interval ? { interval: next.interval } : {}),
        },
      ]);
    if (next.status === "past_due" && prev.status !== "past_due")
      out.push(["plan.payment_failed", { tier: next.tier }]);
    if (next.status === "lapsed" && prev.status !== "lapsed")
      out.push(["plan.lapse", { tier: next.tier }]);
    if (next.cancelsAt != null && prev.cancelsAt == null)
      out.push(["plan.cancel", { tier: next.tier }]);
    return out.map(([action, detail]) =>
      audit(
        env,
        action,
        { type: "settings", id: "billing" },
        { kind: "system", id: null },
        { detail, when: { sql: "changes() > 0", args: [] } },
      ),
    );
  } catch {
    return [];
  }
}

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
  const prev = planOfRaw(env, before?.plan, before?.check, now);
  const audits = planAudits(
    env,
    parseStored(TierAnswerSchema, before?.plan),
    answer,
  );
  // The audit rows follow STORE_PLAN at once, while its changes() holds.
  const [stored] = await env.DB.batch([
    env.DB.prepare(STORE_PLAN).bind(JSON.stringify(answer)),
    ...audits,
    env.DB.prepare(CHECK_OK).bind(now),
  ]);
  const applied = (stored?.results.length ?? 0) > 0;
  if (!applied) return false;
  const next = effectivePlan(answer, null, env.TIER, now);
  if (next.lock && !prev?.lock) {
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
 * a failure is recorded and logged by category. No BILLING gate in this
 * invocation (billing inert): skipped, nothing recorded.
 */
export async function refreshPlan(
  env: Env,
  now: number,
  o: { onDemand?: boolean; ctx?: Ctx } = {},
): Promise<"stored" | "unchanged" | "skipped" | "failed"> {
  if (!billingActive(env)) return "skipped";
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
    // The first good read marks when billing went live (usage reports start
    // no earlier).
    await env.DB.prepare(
      "insert or ignore into settings (key, value) values (?1, ?2)",
    )
      .bind(LIVE_KEY, monthOf(now))
      .run();
    // Version 0 is billing's default for an install it has no row for
    // (free, active). With a provisioned TIER (an install made before the
    // tier store), that's no information: TIER stays the last good tier,
    // and the read still counts as good (the 7-day clock stops).
    if (r.data.version === 0 && parseTier(env.TIER) !== null) {
      await env.DB.prepare(CHECK_OK).bind(now).run();
      return "unchanged";
    }
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
 * free and active only) and cache the answer. Never throws; null on failure
 * (the invite or restore that asked refuses with billing_unavailable).
 */
export async function startTrial(
  env: Env,
  now: number,
  ctx?: Ctx,
): Promise<boolean> {
  return (await startTrialAnswer(env, now, ctx))?.tier === "trial";
}

/** startTrial's answer (cached), or null when billing couldn't be reached or answered badly. */
export async function startTrialAnswer(
  env: Env,
  now: number,
  ctx?: Ctx,
): Promise<StoredPlan | null> {
  if (!billingActive(env)) return null;
  try {
    const raw = await billingCall(env, TRIAL_PATH, {}, now);
    const r = TierAnswerSchema.safeParse(raw);
    if (!r.success) throw new BillingUnavailableError("bad_answer");
    await storePlan(env, r.data, now, ctx);
    logInfo("billing_trial", { tier: r.data.tier });
    return r.data;
  } catch (e) {
    const why = e instanceof BillingUnavailableError ? e.why : "error";
    logWarn("billing_trial_failed", undefined, { why });
    return null;
  }
}

/**
 * The scheduler tick's billing step: read the tier. It never starts the
 * Team trial: that starts only on an invite or a restore (members.ts),
 * each of which announces it (#1851).
 */
export async function billingTick(env: Env, now: number): Promise<void> {
  if (!billingActive(env)) return;
  await refreshPlan(env, now);
}
