// Self-serve billing (post-M1): the plan an install is on, as GET R.me
// reports it (Me.instance.billing), and the enforcement codes. Hosted only:
// self-hosted installs keep TIER/FEATURES and never carry a plan. Index:
// packages/shared/HOSTED_CONTRACT.md "Self-serve billing".
import { z } from "zod";

/**
 * The tier billing stores (oa-<p>-billing `tiers.tier`): solo is one person
 * and their agents ($1/month or $12/year after a 30-day no-card trial), trial
 * is everything in Business for 14 days from the first invite, team and
 * business are paid per creator. free is the pre-Solo value: hosted billing
 * that predates Solo still answers it, and it keeps today's rules (the solo
 * lock, the first invite starts the trial). Billing must report a Solo whose
 * 30-day trial ended with no card as status lapsed.
 */
export const BillingTierSchema = z.enum([
  "free",
  "solo",
  "trial",
  "team",
  "business",
]);
export type BillingTier = z.infer<typeof BillingTierSchema>;

/** Billing's status column: past_due runs a grace period, lapsed is unpaid. */
export const BillingStatusSchema = z.enum([
  "active",
  "past_due",
  "lapsed",
  "suspended",
]);
export type BillingStatus = z.infer<typeof BillingStatusSchema>;

/**
 * Why team features are read-only (PlanView.reason), or why a free instance
 * refuses them:
 * - solo: a Solo instance (one person); team features need a plan.
 * - solo_unpaid: no paid Solo subscription (lapsed, past due after the
 *   grace period, on tier solo): view-only for everyone, the owner too.
 * - trial_ended: the 14-day trial is over and no plan was bought.
 * - lapsed: the subscription ended or was never paid (billing said lapsed).
 * - payment_failed: past due and the grace period is over.
 * - suspended: an operator suspended the instance.
 * - billing_unreachable: OUR outage: the tier couldn't be read for over 7
 *   days (PLAN_STALE_MS). The last good tier applies until then.
 */
export const PlanReasonSchema = z.enum([
  "solo",
  "solo_unpaid",
  "trial_ended",
  "lapsed",
  "payment_failed",
  "suspended",
  "billing_unreachable",
]);
export type PlanReason = z.infer<typeof PlanReasonSchema>;

/**
 * Me.instance.billing (hosted only; absent self-hosted and on older servers).
 * Everyone sees tier, readOnly and reason (the banner). status, trialEndsAt,
 * graceUntil and creatorsThisMonth are billing details: the org owner and
 * admins only; null (creatorsThisMonth absent) for everyone else.
 */
export const PlanViewSchema = z.object({
  tier: BillingTierSchema,
  /** Owner and admins; null for others. */
  status: BillingStatusSchema.nullable(),
  /** ISO; the trial's end (set once a trial started). Owner and admins; null for others. */
  trialEndsAt: z.string().nullable(),
  /**
   * ISO; the Solo trial's end. Separate from trialEndsAt, which is the
   * Business trial's only. Owner and admins; null for others; absent when
   * billing's answer predates it.
   */
  soloTrialEndsAt: z.string().nullable().optional(),
  /** ISO; while past_due, the grace period's end. Owner and admins; null for others. */
  graceUntil: z.string().nullable(),
  /** Distinct creators this UTC calendar month so far (CREATOR definition). Owner and admins only. */
  creatorsThisMonth: z.number().int().nonnegative().optional(),
  /**
   * Team features are read-only (spaces, invites, every write by anyone but
   * the org owner), except sharing, which is free on every plan: sharing an
   * artifact and changing who can open it always work. Nothing is deleted;
   * the owner's own artifacts stay readable and writable.
   */
  readOnly: z.boolean(),
  /** Why readOnly, or why a free instance refuses team features ("solo"). */
  reason: PlanReasonSchema.optional(),
});
export type PlanView = z.infer<typeof PlanViewSchema>;

/**
 * details of 403 plan_required and plan_read_only: the tier, and why. The
 * dashboard shows the paywall (plan_required) or the read-only banner.
 */
export const PlanRefusalDetailsSchema = z.object({
  tier: BillingTierSchema,
  reason: PlanReasonSchema,
});
export type PlanRefusalDetails = z.infer<typeof PlanRefusalDetailsSchema>;

/**
 * A free-tier cap (apps/server billing/caps.ts; each is off until the
 * operator sets it): storage_bytes (FREE_STORAGE_BYTES), data_docs per
 * artifact (FREE_DATA_DOCS), data_daily_writes per artifact per UTC day
 * (FREE_DATA_DAILY_WRITES).
 */
export const PlanLimitSchema = z.enum([
  "storage_bytes",
  "data_docs",
  "data_daily_writes",
]);
export type PlanLimit = z.infer<typeof PlanLimitSchema>;

/**
 * details of 403 plan_limit: which cap, and its value. The paywall names it.
 * The server emits solo; free is still accepted because a server from before
 * Solo sent it.
 */
export const PlanLimitDetailsSchema = z.object({
  tier: z.enum(["solo", "free"]),
  limit: PlanLimitSchema,
  max: z.number().int().positive(),
});
export type PlanLimitDetails = z.infer<typeof PlanLimitDetailsSchema>;

/** Last good tier kept this long when billing is unreachable (OUR outage). */
export const PLAN_STALE_MS = 7 * 86_400_000;
/** The trial billing starts at the first invite. */
export const TRIAL_DAYS = 14;

/**
 * POST R.billingCheckout body: the plan to buy. Solo also names the billing
 * interval (month or year); the billing service maps solo+month and
 * solo+year to the Solo prices. Any other tier refuses an interval. The
 * answer is BillingUrl, the Stripe Checkout page to open; nothing else.
 */
export const BillingIntervalSchema = z.enum(["month", "year"]);
export type BillingInterval = z.infer<typeof BillingIntervalSchema>;
export const BillingCheckoutInputSchema = z
  .strictObject({
    tier: z.enum(["solo", "team", "business"]),
    interval: BillingIntervalSchema.optional(),
  })
  .refine((v) => (v.tier === "solo") === (v.interval !== undefined), {
    message: "interval is required for solo and refused for other tiers",
    path: ["interval"],
  });
export type BillingCheckoutInput = z.infer<typeof BillingCheckoutInputSchema>;

/** R.billingCheckout and R.billingPortal answer: a Stripe-hosted URL only. */
export const BillingUrlSchema = z.object({ url: z.string() });
export type BillingUrl = z.infer<typeof BillingUrlSchema>;

/** POST R.billingUsage answer: the report just sent for this month. */
export const BillingUsageSchema = z.object({
  /** UTC calendar month, YYYY-MM. */
  month: z.string(),
  count: z.number().int().nonnegative(),
});
export type BillingUsage = z.infer<typeof BillingUsageSchema>;
