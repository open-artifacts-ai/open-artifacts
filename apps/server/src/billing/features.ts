import { AsyncLocalStorage } from "node:async_hooks";
import { ENV_FEATURE_FLAGS, type FeatureFlag } from "@oa/shared";
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
// is read at most once per invocation (withPlanScope: the fetch entry, the
// app and the scheduler), lazily: the user load seeds it from its own
// statement (services/users.ts seedPlan), and anything else that needs it
// awaits planNow (the route gate, for every app route but the SPA and its
// assets; the scheduler tick). The content host never reads it. Every
// features read in the invocation sees the same plan.
//
// Outside a scope (a Durable Object's own alarm or RPC) the provisioned
// FEATURES apply. DirectorySync never relies on that: every kick, feed and
// RPC hands it the caller's directory mode (services/directory.ts
// syncModeFor), and it follows that mode.

type PlanScope = {
  /** undefined: not read yet; null: the read failed. */
  plan?: EffectivePlan | null;
  pending?: Promise<EffectivePlan | null>;
};
const scope = new AsyncLocalStorage<PlanScope>();

/**
 * Runs `f` in a plan scope (hosted only). Nothing is read here: the first
 * planNow (or the user load's seedPlan) reads it, once. Nested calls reuse
 * the outer scope.
 */
export async function withPlanScope<T>(
  env: Env,
  f: () => Promise<T>,
): Promise<T> {
  // `return await`, never a bare return: f's rejection gets its handler at
  // once (a returned promise is adopted a tick later, which workerd reports
  // as an unhandled rejection).
  if (!billingOn(env) || scope.getStore()) return await f();
  return await scope.run({}, f);
}

/** The user load read the plan in its own statement: this invocation keeps it. */
export function seedPlan(plan: EffectivePlan | null): void {
  const s = scope.getStore();
  if (s && s.plan === undefined && plan) s.plan = plan;
}

/**
 * This invocation's plan, read once (memoized; concurrent callers share the
 * one read). Null when hosted billing is off. A failed read (D1 down) leaves
 * the provisioned FEATURES for this invocation; the request's own reads
 * fail on their own. Outside a scope it reads on every call.
 */
export async function planNow(
  env: Env,
  now = Date.now(),
): Promise<EffectivePlan | null> {
  if (!billingOn(env)) return null;
  const s = scope.getStore();
  if (!s) return readPlan(env, now);
  if (s.plan !== undefined) return s.plan;
  s.pending ??= readPlan(env, now).then(
    (p) => {
      if (s.plan === undefined) s.plan = p;
      return s.plan ?? null;
    },
    (e) => {
      logWarn("billing_plan_read_failed", e);
      if (s.plan === undefined) s.plan = null;
      return s.plan ?? null;
    },
  );
  return await s.pending;
}

/** This invocation's plan if read (planNow, seedPlan), else null. */
export const scopedPlan = (): EffectivePlan | null =>
  scope.getStore()?.plan ?? null;

/**
 * The instance's feature flags: hosted, the plan's tier (planFeatures);
 * self-hosted, or with no plan read, the FEATURES env. The one source for
 * every feature check (never authConfig(env).features directly). Hosted
 * callers run after planNow (the route gate, the tick); a read before it
 * is logged (billing_plan_unread).
 */
export function featuresOf(env: Env): readonly FeatureFlag[] {
  const base = authConfig(env).features;
  if (!billingOn(env)) return base;
  const s = scope.getStore();
  if (s && s.plan === undefined)
    logWarn("billing_plan_unread", new Error("features read before the plan"));
  const plan = s?.plan ?? null;
  if (!plan) return base;
  // The tier sets the env flags; flags the sign-in config derives
  // (guests_read_only) are not the tier's and stay.
  const derived = base.filter(
    (f) => !(ENV_FEATURE_FLAGS as readonly string[]).includes(f),
  );
  return [...planFeatures(plan), ...derived];
}
