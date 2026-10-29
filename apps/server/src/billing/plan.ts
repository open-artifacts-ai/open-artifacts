import {
  type BillingStatus,
  BillingStatusSchema,
  type BillingTier,
  BillingTierSchema,
  PLAN_STALE_MS,
  type PlanReason,
  type PlanRefusalDetails,
  parseTier,
} from "@oa/shared";
import { z } from "zod";
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
// tier holds for PLAN_STALE_MS (7 days), then team features go read-only;
// it never falls back upward. A real lapse arrives as status "lapsed" and
// applies at once.

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

/** The read attempts: last attempt, and when the current failure run began. */
export const PlanCheckSchema = z.object({
  checkedAt: z.number().int(),
  failingSince: z.number().int().nullable(),
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
 * the provisioned TIER (today's behaviour; free when unset) is the last good
 * tier, and the 7 days run from the first failed read.
 */
export function effectivePlan(
  last: StoredPlan | null,
  check: PlanCheck | null,
  envTier: string | undefined,
  now: number,
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
  // OUR outage: the last good answer is over 7 days old (or, with none, the
  // failures began over 7 days ago). Never upward: read-only.
  const since = last ? last.asOf : (check?.failingSince ?? null);
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

/** The plan from the two raw settings values (null when hosted billing is off). */
export function planOfRaw(
  env: Pick<Env, "HOSTED" | "TIER">,
  plan: string | null | undefined,
  check: string | null | undefined,
  now: number,
): EffectivePlan | null {
  if (!billingOn(env)) return null;
  const last = parseStored(TierAnswerSchema, plan);
  const c = parseStored(PlanCheckSchema, check);
  // Unknown: no answer yet, no provisioned TIER, and not failing for 7 days.
  // Today's behaviour until the first read (the scheduler tick, every 2
  // min); the outage rule still applies to an install that never read one.
  if (
    !last &&
    parseTier(env.TIER) === null &&
    !(c?.failingSince != null && now - c.failingSince > PLAN_STALE_MS)
  )
    return null;
  return effectivePlan(last, c, env.TIER, now);
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
