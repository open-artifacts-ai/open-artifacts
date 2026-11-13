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
// Hosted only (billingOn), and only where the BILLING gate is bound
// (billingActive; ctx.props.BILLING, which the hosted billing Worker's deploy
// from the cloud repo provides). With no gate there is no plan at all, as on
// self-host: planOfRaw is null, so no "plan" cap, no team-feature refusals,
// no trial start, no free caps, no usage report, and the billing routes 404;
// features keep following the provisioned FEATURES and TIER. A self-hosted
// install keeps TIER and FEATURES as today: HOSTED=1 only ever tightens, and
// only with the gate.
//
// The last good tier is cached in D1 settings (PLAN_KEY, written only by
// store.ts with the version rule). Billing unreachable (OUR outage): that
// tier holds for PLAN_STALE_MS (7 days) from the last good read, then team
// features go read-only; it never falls back upward. A real lapse arrives as
// status "lapsed" and applies at once.
//
// A cached Team trial whose end has passed is Solo at once (#1756), not
// read-only, until billing's next answer; billing's scheduler read and the
// owner's on-demand read (me.ts) already refresh it, so no new timer.
//
// With the gate (planOfRaw): the billing tier, i.e. the cached answer, with
// the 7-day last-good rule. With no answer yet, the provisioned TIER is the
// last good tier; with neither, solo (trial allowed), never unenforced.
//
// Features (Me.instance.features and every check) follow the plan's tier at
// read time through TIER_FEATURES, not the provisioned FEATURES (planFeatures).

/** Hosted billing is on: HOSTED=1 only (self-hosted installs have no gate). */
export const billingOn = (env: Pick<Env, "HOSTED">): boolean =>
  env.HOSTED === "1";

/**
 * Billing is live in this invocation: hosted, with the BILLING gate bound.
 * Everything that enforces, starts a trial, reports usage or serves a
 * billing route needs it; without it billing is inert, as on self-host.
 */
export const billingActive = (env: Pick<Env, "HOSTED">): boolean =>
  billingOn(env) && billingGate() !== null;

/** settings key: the last good GET /tier answer (StoredPlan JSON). */
export const PLAN_KEY = "billing.plan";
/** settings key: the read attempts (PlanCheck JSON). */
export const CHECK_KEY = "billing.check";

/** GET /tier as billing answers it (oa-<p>-billing view()). Times in ms. */
export const TierAnswerSchema = z.object({
  tier: BillingTierSchema,
  status: BillingStatusSchema,
  trialEndsAt: z.number().int().nullable(),
  /**
   * End of the Solo 30-day trial (ms). Separate from trialEndsAt, which stays
   * the Team trial's: trialEligible reads "Team trial never used" off
   * trialEndsAt === null. Absent from an answer that predates it.
   */
  soloTrialEndsAt: z.number().int().nullable().optional(),
  graceUntil: z.number().int().nullable(),
  /** A Stripe customer exists for this install. Absent from an answer that predates it (unknown). */
  hasCustomer: z.boolean().optional(),
  /** Yearly Team and Business prices are configured. Absent from an answer that predates it (off). */
  yearlyTeamBusiness: z.boolean().optional(),
  /** A Checkout put a card on file. Absent from an answer that predates it (off). */
  soloCheckedOut: z.boolean().optional(),
  /** When a scheduled cancel takes effect (ms), or null. Absent from an answer that predates it. */
  cancelsAt: z.number().int().nullable().optional(),
  /** The billing interval and the renewal date (ms). Absent from an answer that predates them. */
  interval: z.enum(["month", "year"]).nullable().optional(),
  renewsAt: z.number().int().nullable().optional(),
  /** Unpaid extra-creator charges (#2246). Billing sends null for none; absent from an older answer. */
  overageDue: z
    .object({
      amountCents: z.number().int().nonnegative(),
      months: z.array(z.string().regex(/^\d{4}-\d{2}$/)).min(1),
    })
    .nullish(),
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
 * - solo: a Solo instance. Team features answer plan_required; an invite is
 *   allowed while the trial was never used (it starts the trial).
 * - readOnly: team features are read-only (plan_read_only). Nothing is
 *   deleted; removals (a member) still pass. Sharing is never locked.
 * - viewOnly: an unpaid Solo (reason solo_unpaid). Binds EVERYONE, the org
 *   owner included: publishing and live-data writes are refused (403
 *   plan_read_only, planRefuses and publish), team features as under solo.
 *   Non-owners carry the "plan" cap as under solo. Reads, sharing and billing
 *   keep working.
 */
export type PlanLock = {
  mode: "solo" | "readOnly" | "viewOnly";
  tier: BillingTier;
  reason: PlanReason;
};

export type EffectivePlan = {
  tier: BillingTier;
  status: BillingStatus;
  trialEndsAt: number | null;
  /** The Solo trial's end; absent when the answer carried none. */
  soloTrialEndsAt?: number | null;
  /** Absent when billing's answer carried none (unknown). */
  hasCustomer?: boolean;
  /** Absent when billing's answer carried none (off). */
  yearlyTeamBusiness?: boolean;
  soloCheckedOut?: boolean;
  cancelsAt?: number | null;
  interval?: "month" | "year" | null;
  renewsAt?: number | null;
  /** Absent when billing's answer carried none or null (nothing due). */
  overageDue?: { amountCents: number; months: string[] };
  graceUntil: number | null;
  readOnly: boolean;
  reason?: PlanReason;
  lock: PlanLock | null;
  /** Solo and the trial never started: the first invite starts it. */
  trialEligible: boolean;
};

/**
 * The plan from the cached answer and the read attempts. With no answer yet,
 * the provisioned TIER (solo when unset) is the last good tier. The 7 days
 * run from the last good read (the answer's asOf, or a good read of an older
 * version), else from the first failed read.
 */
export function effectivePlan(
  last: StoredPlan | null,
  check: PlanCheck | null,
  envTier: string | undefined,
  now: number,
): EffectivePlan {
  // Billing's version 0 is "no row for this install" (solo, active): no
  // information. It must not lower an install provisioned Team or Business:
  // the plan follows TIER, as with no answer. `last` still counts for the
  // 7-day clock below (billing was reachable).
  const provisioned = parseTier(envTier);
  const noRow =
    last !== null &&
    last.version === 0 &&
    (provisioned === "team" || provisioned === "business");
  const used = noRow ? null : last;
  const answer = used ?? {
    tier: provisioned ?? ("solo" as const),
    status: "active" as const,
    trialEndsAt: null,
    graceUntil: null,
  };
  // #1568, #1756: the end of the Team trial returns to Solo, never a full
  // lock. A billing answer (not the provisioned TIER) whose trial date has
  // passed is Solo now, with its status read as Solo's (lapsed or past due is
  // the unpaid view-only lock), until billing's next answer replaces it.
  const trialOver =
    used !== null &&
    answer.tier === "trial" &&
    answer.trialEndsAt !== null &&
    now > answer.trialEndsAt;
  const base = trialOver ? { ...answer, tier: "solo" as const } : answer;
  const out = (reason: PlanReason | null, mode: PlanLock["mode"] | null) => ({
    tier: base.tier,
    status: base.status,
    trialEndsAt: base.trialEndsAt,
    ...("soloTrialEndsAt" in base && base.soloTrialEndsAt !== undefined
      ? { soloTrialEndsAt: base.soloTrialEndsAt }
      : {}),
    ...("hasCustomer" in base && base.hasCustomer !== undefined
      ? { hasCustomer: base.hasCustomer }
      : {}),
    ...("yearlyTeamBusiness" in base && base.yearlyTeamBusiness !== undefined
      ? { yearlyTeamBusiness: base.yearlyTeamBusiness }
      : {}),
    ...("soloCheckedOut" in base && base.soloCheckedOut !== undefined
      ? { soloCheckedOut: base.soloCheckedOut }
      : {}),
    ...("cancelsAt" in base && base.cancelsAt !== undefined
      ? { cancelsAt: base.cancelsAt }
      : {}),
    ...("interval" in base && base.interval !== undefined
      ? { interval: base.interval }
      : {}),
    ...("renewsAt" in base && base.renewsAt !== undefined
      ? { renewsAt: base.renewsAt }
      : {}),
    ...("overageDue" in base && base.overageDue
      ? { overageDue: base.overageDue }
      : {}),
    graceUntil: base.graceUntil,
    readOnly: mode === "readOnly" || mode === "viewOnly",
    ...(reason ? { reason } : {}),
    lock: reason && mode ? { mode, tier: base.tier, reason } : null,
    trialEligible:
      mode === "solo" &&
      base.status === "active" &&
      (base.tier === "solo" || base.tier === "free") &&
      base.trialEndsAt === null,
  });
  // OUR outage: the last good read is over 7 days old (or, with none, the
  // failures began over 7 days ago). Never upward: read-only.
  const good = Math.max(last?.asOf ?? -1, check?.lastGoodAt ?? -1);
  const since = good >= 0 ? good : (check?.failingSince ?? null);
  if (since !== null && now - since > PLAN_STALE_MS)
    return out("billing_unreachable", "readOnly");
  // Solo only: a lapse (or a past-due grace that is over) is view-only, not
  // the team read-only. The pre-Solo tier free keeps today's rules.
  const unpaidSolo = base.tier === "solo";
  switch (base.status) {
    case "suspended":
      return out("suspended", "readOnly");
    case "lapsed":
      if (unpaidSolo) return out("solo_unpaid", "viewOnly");
      return out(base.tier === "trial" ? "trial_ended" : "lapsed", "readOnly");
    case "past_due":
      // Grace runs until graceUntil; billing sets it with past_due. Fail
      // closed on a missing date: the grace is 7 days from the answer (past_due
      // only ever comes from a billing answer).
      if (now > (base.graceUntil ?? (last?.asOf ?? now) + PLAN_STALE_MS))
        return unpaidSolo
          ? out("solo_unpaid", "viewOnly")
          : out("payment_failed", "readOnly");
      break;
  }
  // A billing answer for a trial with no end date counts as ended (fail
  // closed). Not the provisioned TIER fallback (`last` null): a trial
  // install provisioned before billing answered has no dates at all.
  // (A passed trial date is Solo, above.)
  if (base.tier === "trial" && used !== null && base.trialEndsAt === null)
    return out("trial_ended", "readOnly");
  // free is the pre-Solo tier: the solo lock, as before Solo existed.
  if (base.tier === "free" || base.tier === "solo") return out("solo", "solo");
  return out(null, null);
}

/**
 * The plan from the two raw settings values (null when hosted billing is
 * off, or the BILLING gate is absent: no plan, as on self-host). `gate`: whether this invocation carries
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
  // No BILLING gate: no plan, nothing enforced, nothing recorded.
  if (!(o.gate ?? billingGate() !== null)) return null;
  const last = parseStored(TierAnswerSchema, plan);
  const c = parseStored(PlanCheckSchema, check);
  // The billing tier, with the last-good rule. No answer and no TIER: solo
  // (solo, trial allowed) until the first good read, never unenforced.
  return effectivePlan(last, c, env.TIER, now);
}

/** Hosted adds usage_off on every tier (no ANALYTICS_TOKEN there). */
const HOSTED_FLAGS: readonly EnvFeatureFlag[] = ["usage_off"];

/**
 * The feature flags for `plan`'s tier (TIER_FEATURES). A solo or free
 * instance reports the trial's, so the paywall can show them: its team
 * features are refused by the solo lock. Only Business has sync_google; every
 * other plan is sync_frozen, so a downgrade swaps it: nothing is deleted or
 * disconnected, sign-in and user-status checks keep running, and nothing
 * syncs. A lapse keeps the tier's features, read-only (the lock).
 */
export function planFeatures(plan: EffectivePlan): EnvFeatureFlag[] {
  const tier =
    plan.tier === "free" || plan.tier === "solo" ? "trial" : plan.tier;
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
  if (!billingActive(env)) return null;
  const r = await env.DB.prepare(READ_PLAN).first<{
    plan: string | null;
    check: string | null;
  }>();
  return planOfRaw(env, r?.plan, r?.check, now);
}

/** Hosted: the Directory API and its creating writes are Business only. */
export const directoryPlanError = (tier?: string): ApiError =>
  new ApiError(
    "plan_required",
    "Directory sync is on the Business plan.",
    tier ? { tier } : undefined,
  );

/** The refusal for a team-feature write under `lock`. */
export function planError(lock: PlanLock): ApiError {
  const details: PlanRefusalDetails = { tier: lock.tier, reason: lock.reason };
  if (lock.mode === "viewOnly")
    return new ApiError(
      "plan_read_only",
      "Publishing is paused until this instance's Solo plan is paid.",
      details,
    );
  return lock.mode === "solo"
    ? new ApiError(
        "plan_required",
        "This needs a team plan: a Solo instance is for one person",
        details,
      )
    : new ApiError(
        "plan_read_only",
        "Team features are read-only until the plan is paid; nothing was deleted",
        details,
      );
}

/** `lock` is the unpaid-Solo view-only lock (binds everyone, the owner too). */
export const isViewOnly = (lock: PlanLock | null | undefined): boolean =>
  lock?.mode === "viewOnly";

/**
 * The one refusal for publishing and writes under the view-only lock:
 * 403 plan_read_only (never 404), for everyone, the org owner included.
 */
export function refuseViewOnly(plan: EffectivePlan | null | undefined): void {
  const lock = plan?.lock;
  if (lock && isViewOnly(lock)) throw planError(lock);
}

/**
 * Team features (an invite, a shared space and its members, mappings and
 * moves) need a plan; sharing an artifact never does (free on every plan): plan_required on a solo
 * instance, plan_read_only while read-only. `invite`: the first invite on a
 * solo instance whose trial never ran passes (it starts the trial).
 */
export function requireTeamPlan(
  plan: EffectivePlan | null,
  o: { invite?: boolean } = {},
): void {
  if (!plan?.lock) return;
  if (o.invite && plan.trialEligible) return;
  throw planError(plan.lock);
}
