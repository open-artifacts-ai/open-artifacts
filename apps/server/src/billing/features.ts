import { AsyncLocalStorage } from "node:async_hooks";
import type { FeatureFlag } from "@oa/shared";
import { authConfig } from "../auth/config.js";
import type { Env } from "../env.js";
import { logWarn } from "../log.js";
import {
  billingOn,
  type EffectivePlan,
  planFeatures,
  readPlan,
} from "./plan.js";

// Hosted billing: the instance's features follow the billing tier at read
// time (planFeatures: TIER_FEATURES), not the provisioned FEATURES. The plan
// is read once per invocation (withPlanScope: the fetch entry, the app and
// the scheduler) and every features read in it sees the same plan.
//
// Outside a scope (a Durable Object's own alarm or RPC) the provisioned
// FEATURES apply, as before billing. Those paths only ever act on what a
// scoped request or tick started: directory sync is fed only by the
// scheduler tick (feedSync, skipped when locked or not syncing).

type PlanScope = { plan: EffectivePlan | null };
const scope = new AsyncLocalStorage<PlanScope>();

/**
 * Runs `f` with the instance's plan read once (hosted only). Nested calls
 * reuse the outer read. A failed read (D1 down) leaves the provisioned
 * FEATURES for this invocation; the request's own reads fail on their own.
 */
export async function withPlanScope<T>(
  env: Env,
  f: () => Promise<T>,
  now = Date.now(),
): Promise<T> {
  // `return await`, never a bare return: f's rejection gets its handler at
  // once (a returned promise is adopted a tick later, which workerd reports
  // as an unhandled rejection).
  if (!billingOn(env) || scope.getStore()) return await f();
  let plan: EffectivePlan | null = null;
  try {
    plan = await readPlan(env, now);
  } catch (e) {
    logWarn("billing_plan_read_failed", e);
  }
  return await scope.run({ plan }, f);
}

/** This invocation's plan (withPlanScope), or null (none read, or self-hosted). */
export const scopedPlan = (): EffectivePlan | null =>
  scope.getStore()?.plan ?? null;

/**
 * The instance's feature flags: hosted, the plan's tier (planFeatures);
 * self-hosted, or with no plan read, the FEATURES env. The one source for
 * every feature check (never authConfig(env).features directly).
 */
export function featuresOf(env: Env): readonly FeatureFlag[] {
  const base = authConfig(env).features;
  if (!billingOn(env)) return base;
  const plan = scopedPlan();
  return plan ? planFeatures(plan) : base;
}
