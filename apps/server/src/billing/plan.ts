import {
  type BillingStatus,
  BillingStatusSchema,
  type BillingTier,
  BillingTierSchema,
  type EnvFeatureFlag,
  PLAN_STALE_MS,
  type PlanReason,
  type PlanRefusalDetails,
  parseTier,
  TIER_FEATURES,
} from "@oa/shared";
import { z } from "zod";
import { billingGate } from "../auth/broker-transport.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";

// Self-serve billing, install side: the plan this install is on and what it
// allows. One source (effectivePlan) for every check: the cap on every
// caller but the org owner (services/users.ts), the team-feature refusals
// (requireTeamPlan), the artifact writes in shared spaces (policy can) and
// Me.instance.billing.
//
// Hosted only (billingOn). A self-hosted install keeps TIER and FEATURES as
// today with no gate: HOSTED=1 only ever tightens.
//
// The last good tier is cached in D1 settings (PLAN_KEY, written only by
// store.ts with the version rule). Billing unreachable (OUR outage): that
// tier holds for PLAN_STALE_MS (7 days) from the last good read, then team
// features go read-only; it never falls back upward. A real lapse arrives as
// status "lapsed" and applies at once.
//
// Precedence (planOfRaw), hosted only:
// 1. The BILLING gate is present (ctx.props.BILLING): the billing tier, i.e.
//    the cached answer, with the 7-day last-good rule. With no answer yet,
//    the provisioned TIER is the last good tier; with neither, free (solo,
//    trial allowed), never unenforced.
// 2. The gate is absent (before #849 is deployed, or a context without it):
//    no billing enforcement: the provisioned TIER, never unreachable, and no
//    7-day clock. Without a TIER: no plan (the provisioned FEATURES, as
//    before billing). Nothing is recorded (store.ts refreshPlan skips).
//
// Features (Me.instance.features and every check) follow the plan's tier at
// read time through TIER_FEATURES, not the provisioned FEATURES (planFeatures).

/** Hosted billing is on: HOSTED=1 only (self-hosted installs have no gate). */
export const billingOn = (env: Pick<Env, "HOSTED">): boolean =>
  env.HOSTED === "1";

/** settings key: the last good GET /tier answer (StoredPlan JSON). */
export const PLAN_KEY = "billing.plan";
/** settings key: the read attempts (PlanCheck JSON). */
export const CHECK_KEY = "billing.check";

/** GET /tier as billing answers it (oa-<p>-billing view()). Times in ms. */
export const TierAnswerSchema = z.object({
  tier: BillingTierSchema,
  status: BillingStatusSchema,
  trialEndsAt: z.number().int().nullable(),
  graceUntil: z.number().int().nullable(),
  version: z.number().int().nonnegative(),
  asOf: z.number().int().positive(),
});
export type StoredPlan = z.infer<typeof TierAnswerSchema>;

/**
 * The read attempts: last attempt, when the current failure run began, and
 * the last good read of any version (an older version is reachable billing
 * too: the 7-day clock stops, though the older tier is never applied).
 */
export const PlanCheckSchema = z.object({
  checkedAt: z.number().int(),
  failingSince: z.number().int().nullable(),
  lastGoodAt: z.number().int().nullable().optional(),
});
export type PlanCheck = z.infer<typeof PlanCheckSchema>;

/** A stored JSON value, or null when missing or malformed (fail closed: no plan). */
export function parseStored<T>(
  schema: z.ZodType<T>,
  raw: string | null | undefined,
): T | null {
  if (!raw) return null;
  try {
    const r = schema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/**
 * What the plan locks, for everyone but the org owner (the "plan" cap) and
 * for the owner's team features:
 * - solo: a free instance. Team features answer plan_required; an invite is
 *   allowed while the trial was never used (it starts the trial).
 * - readOnly: team features are read-only (plan_read_only). Nothing is
 *   deleted; removals (a member, a share) still pass.
 */
export type PlanLock = {
  mode: "solo" | "readOnly";
  tier: BillingTier;
  reason: PlanReason;
};

export type EffectivePlan = {
  tier: BillingTier;
  status: BillingStatus;
  trialEndsAt: number | null;
  graceUntil: number | null;
  readOnly: boolean;
  reason?: PlanReason;
  lock: PlanLock | null;
  /** Free and the trial never started: the first invite starts it. */
  trialEligible: boolean;
};

/**
 * The plan from the cached answer and the read attempts. With no answer yet,
 * the provisioned TIER (free when unset) is the last good tier. The 7 days
 * run from the last good read (the answer's asOf, or a good read of an older
 * version), else from the first failed read. `clock: false`: no outage rule
 * (the BILLING gate is absent: nothing is unreachable).
 */
export function effectivePlan(
  last: StoredPlan | null,
  check: PlanCheck | null,
  envTier: string | undefined,
  now: number,
  o: { clock?: boolean } = {},
): EffectivePlan {
  const base = last ?? {
    tier: parseTier(envTier) ?? ("free" as const),
    status: "active" as const,
    trialEndsAt: null,
    graceUntil: null,
  };
  const out = (reason: PlanReason | null, mode: PlanLock["mode"] | null) => ({
    tier: base.tier,
    status: base.status,
    trialEndsAt: base.trialEndsAt,
    graceUntil: base.graceUntil,
    readOnly: mode === "readOnly",
    ...(reason ? { reason } : {}),
    lock: reason && mode ? { mode, tier: base.tier, reason } : null,
    trialEligible:
      mode === "solo" && base.tier === "free" && base.trialEndsAt === null,
  });
  // OUR outage: the last good read is over 7 days old (or, with none, the
  // failures began over 7 days ago). Never upward: read-only.
  const good = Math.max(last?.asOf ?? -1, check?.lastGoodAt ?? -1);
  const since =
    o.clock === false ? null : good >= 0 ? good : (check?.failingSince ?? null);
  if (since !== null && now - since > PLAN_STALE_MS)
    return out("billing_unreachable", "readOnly");
  switch (base.status) {
    case "suspended":
      return out("suspended", "readOnly");
    case "lapsed":
      return out(base.tier === "trial" ? "trial_ended" : "lapsed", "readOnly");
    case "past_due":
      // Grace runs until graceUntil; billing sets it with past_due.
      if (base.graceUntil !== null && now > base.graceUntil)
        return out("payment_failed", "readOnly");
      break;
  }
  if (
    base.tier === "trial" &&
    base.trialEndsAt !== null &&
    now > base.trialEndsAt
  )
    return out("trial_ended", "readOnly");
  if (base.tier === "free") return out("solo", "solo");
  return out(null, null);
}

/**
 * The plan from the two raw settings values (null when hosted billing is
 * off), by the precedence above. `gate`: whether this invocation carries
 * the BILLING gate (default: billingGate()).
 */
export function planOfRaw(
  env: Pick<Env, "HOSTED" | "TIER">,
  plan: string | null | undefined,
  check: string | null | undefined,
  now: number,
  o: { gate?: boolean } = {},
): EffectivePlan | null {
  if (!billingOn(env)) return null;
  const last = parseStored(TierAnswerSchema, plan);
  const c = parseStored(PlanCheckSchema, check);
  const gate = o.gate ?? billingGate() !== null;
  if (!gate) {
    // No BILLING: no billing enforcement. The provisioned TIER (never
    // unreachable, no 7-day clock); without one, no plan at all (the
    // provisioned FEATURES, as before billing). The cache is not consulted.
    const tier = parseTier(env.TIER);
    return tier !== null
      ? effectivePlan(null, null, tier, now, { clock: false })
      : null;
  }
  // The billing tier, with the last-good rule. No answer and no TIER: free
  // (solo, trial allowed) until the first good read, never unenforced.
  return effectivePlan(last, c, env.TIER, now);
}

/** Hosted adds usage_off on every tier (no ANALYTICS_TOKEN there). */
const HOSTED_FLAGS: readonly EnvFeatureFlag[] = ["usage_off"];

/**
 * The feature flags for `plan`'s tier (TIER_FEATURES; the trial is
 * Business, and a free instance reports the trial's features: its team
 * features are refused by the solo lock, so the paywall can show them). A
 * downgrade to Team swaps sync_google for sync_frozen: nothing is deleted
 * or disconnected. A lapse keeps the tier's features, read-only (the lock).
 */
export function planFeatures(plan: EffectivePlan): EnvFeatureFlag[] {
  const tier = plan.tier === "free" ? "trial" : plan.tier;
  return [...TIER_FEATURES[tier], ...HOSTED_FLAGS];
}

const READ_PLAN = `select
  (select value from settings where key = '${PLAN_KEY}') as plan,
  (select value from settings where key = '${CHECK_KEY}') as "check"`;

/** The plan now (two settings PK reads), or null when hosted billing is off. */
export async function readPlan(
  env: Env,
  now = Date.now(),
): Promise<EffectivePlan | null> {
  if (!billingOn(env)) return null;
  const r = await env.DB.prepare(READ_PLAN).first<{
    plan: string | null;
    check: string | null;
  }>();
  return planOfRaw(env, r?.plan, r?.check, now);
}

/** The refusal for a team-feature write under `lock`. */
export function planError(lock: PlanLock): ApiError {
  const details: PlanRefusalDetails = { tier: lock.tier, reason: lock.reason };
  return lock.mode === "solo"
    ? new ApiError(
        "plan_required",
        "This needs a team plan: a free instance is for one person",
        details,
      )
    : new ApiError(
        "plan_read_only",
        "Team features are read-only until the plan is paid; nothing was deleted",
        details,
      );
}

/**
 * Team features (an invite, a share to someone else, a shared space and its
 * members, mappings and moves) need a plan: plan_required on a free
 * instance, plan_read_only while read-only. `invite`: the first invite on a
 * free instance whose trial never ran passes (it starts the trial).
 */
export function requireTeamPlan(
  plan: EffectivePlan | null,
  o: { invite?: boolean } = {},
): void {
  if (!plan?.lock) return;
  if (o.invite && plan.trialEligible) return;
  throw planError(plan.lock);
}
