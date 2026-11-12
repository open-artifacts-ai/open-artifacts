import type { MockOptions } from "@oa/shared/mocks";

export type HostedMockOptions = Exclude<
  NonNullable<MockOptions["hosted"]>,
  boolean
>;

const TOKENS: Record<string, HostedMockOptions> = {
  "1": {},
  access: { mode: "access" },
  "email-only": { providers: ["email"] },
  turnstile: { turnstile: true },
  unhealthy: { unhealthy: true },
  "auth-failed": { unhealthy: true, unhealthyState: "auth_failed" },
  "scope-missing": { unhealthy: true, unhealthyState: "scope_missing" },
  "customer-mismatch": { unhealthy: true, unhealthyState: "customer_mismatch" },
  trial: { tier: "trial" },
  // Solo: in its 30-day trial, and unpaid (view-only, the owner included).
  solo: {
    billing: {
      tier: "solo",
      status: "active",
      trialEndsAt: null,
      // 20 days out, so the note always shows.
      soloTrialEndsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
      graceUntil: null,
      creatorsThisMonth: 1,
      readOnly: false,
    },
  },
  // Solo after a used Team trial: trialEndsAt is the past trial, so no note.
  "solo-used-trial": {
    billing: {
      tier: "solo",
      status: "active",
      trialEndsAt: "2026-10-01T00:00:00.000Z",
      soloTrialEndsAt: null,
      graceUntil: null,
      creatorsThisMonth: 1,
      readOnly: false,
    },
  },
  // The invite trial, a Team trial (#2113), 20 days left.
  "plan-trial": {
    billing: {
      tier: "trial",
      status: "active",
      trialEndsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
      graceUntil: null,
      creatorsThisMonth: 2,
      readOnly: false,
    },
  },
  "plan-team": {
    billing: {
      tier: "team",
      status: "active",
      trialEndsAt: null,
      graceUntil: null,
      creatorsThisMonth: 4,
      readOnly: false,
    },
  },
  // Solo that pays: a Stripe customer, active, no free month (Manage billing only).
  "solo-paid": {
    billing: {
      tier: "solo",
      status: "active",
      trialEndsAt: null,
      soloTrialEndsAt: null,
      graceUntil: null,
      hasCustomer: true,
      creatorsThisMonth: 1,
      readOnly: false,
    },
  },
  // Solo in its free month with a Stripe customer (Pay buttons), and Solo with
  // no customer.
  "solo-trial-customer": {
    billing: {
      tier: "solo",
      status: "active",
      trialEndsAt: null,
      soloTrialEndsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
      graceUntil: null,
      hasCustomer: true,
      creatorsThisMonth: 1,
      readOnly: false,
    },
  },
  // Yearly Team and Business prices configured (billing.yearlyTeamBusiness).
  yearly: {
    billing: {
      tier: "solo",
      status: "active",
      trialEndsAt: null,
      soloTrialEndsAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
      graceUntil: null,
      hasCustomer: true,
      yearlyTeamBusiness: true,
      creatorsThisMonth: 1,
      readOnly: false,
    },
  },
  // Failed extra-creator charges (#2246): one month, and several months.
  "overage-due": {
    billing: {
      tier: "team",
      status: "active",
      trialEndsAt: null,
      graceUntil: null,
      hasCustomer: true,
      creatorsThisMonth: 9,
      overageDue: { amountCents: 4200, months: ["2026-10"] },
      readOnly: false,
    },
  },
  "overage-due-months": {
    billing: {
      tier: "team",
      status: "active",
      trialEndsAt: null,
      graceUntil: null,
      hasCustomer: true,
      creatorsThisMonth: 9,
      overageDue: { amountCents: 11850, months: ["2026-09", "2026-10"] },
      readOnly: false,
    },
  },
  "solo-no-customer": {
    billing: {
      tier: "solo",
      status: "active",
      trialEndsAt: null,
      soloTrialEndsAt: null,
      graceUntil: null,
      hasCustomer: false,
      creatorsThisMonth: 1,
      readOnly: false,
    },
  },
  // Business with no Stripe customer (provisioned or comped), and with one.
  "plan-no-customer": {
    billing: {
      tier: "business",
      status: "active",
      trialEndsAt: null,
      graceUntil: null,
      hasCustomer: false,
      creatorsThisMonth: 4,
      readOnly: false,
    },
  },
  "plan-customer": {
    billing: {
      tier: "business",
      status: "active",
      trialEndsAt: null,
      graceUntil: null,
      hasCustomer: true,
      creatorsThisMonth: 4,
      readOnly: false,
    },
  },
  "plan-team-lapsed": {
    billing: {
      tier: "team",
      status: "lapsed",
      trialEndsAt: null,
      graceUntil: null,
      creatorsThisMonth: 4,
      readOnly: true,
      reason: "lapsed",
    },
  },
  // Team read-only for each reason the banner words (Self-serve screens v6, 3).
  "plan-team-payment-failed": {
    billing: {
      tier: "team",
      status: "past_due",
      trialEndsAt: null,
      graceUntil: "2026-11-01T00:00:00.000Z",
      creatorsThisMonth: 4,
      readOnly: true,
      reason: "payment_failed",
    },
  },
  "plan-team-suspended": {
    billing: {
      tier: "team",
      status: "suspended",
      trialEndsAt: null,
      graceUntil: null,
      creatorsThisMonth: 4,
      readOnly: true,
      reason: "suspended",
    },
  },
  "plan-team-unreachable": {
    billing: {
      tier: "team",
      status: "active",
      trialEndsAt: null,
      graceUntil: null,
      creatorsThisMonth: 4,
      readOnly: true,
      reason: "billing_unreachable",
    },
  },
  "solo-paused": {
    billing: {
      tier: "solo",
      status: "lapsed",
      trialEndsAt: null,
      graceUntil: null,
      creatorsThisMonth: 1,
      readOnly: true,
      reason: "solo_unpaid",
    },
  },
  team: { tier: "team" },
  business: { tier: "business" },
  frozen: { directory: "frozen" },
  "sync-off": { directory: "off" },
  // Business before its first connect (#2009): sync on, nothing connected yet.
  "not-connected": { unbound: true },
  admin: { actAs: "admin" },
  "guest-notices": { selfHosted: true, guestShares: 2, guestOwners: 2 },
  "guest-departed": {
    selfHosted: true,
    guestShares: 2,
    guestOwners: 2,
    departedGuestOwner: true,
  },
  "spaces-on": { spaces: true },
  "every-exec": { everyExec: true },
  "no-spaces": { noSharedSpaces: true },
  "move-target": { moveTarget: true },
  "removed-people": {
    lapsedGuests: ["gus@example.com"],
    carolRemoved: true,
  },
  "workspace-change": {
    pendingCustomerChange: {
      previous: { customerId: "C01abc", domain: "old.example" },
      next: { customerId: "C09xyz", domain: "example.com" },
    },
  },
  "break-glass": {
    breakGlass: "fresh",
    unhealthy: true,
    unhealthyState: "customer_mismatch",
  },
  "break-glass-stale": {
    breakGlass: "stale",
    unhealthy: true,
    unhealthyState: "customer_mismatch",
  },
};

/**
 * Mock-only: `?hosted=` turns on the hosted mocks. Comma tokens: 1 (defaults),
 * access, email-only, turnstile, unhealthy (backoff), auth-failed,
 * scope-missing, customer-mismatch, trial, solo, solo-paid (a paying Solo: customer, active,
 * Manage billing only), solo-trial-customer, solo-no-customer, solo-paused,
 * plan-team-lapsed, plan-team-payment-failed, plan-team-suspended, plan-team-unreachable, team, business, frozen, sync-off, not-connected,
 * admin (you are an admin, not the owner), guest-notices (an Access-only
 * install with parity 2's notices, spaces off), guest-departed (the same, one
 * guest owner has left), spaces-on, workspace-change (the confirm
 * step for a different Google Workspace), break-glass and break-glass-stale
 * (the owner locked out by customer-mismatch, signed in fresh or not). Absent: the self-hosted mocks.
 */
export const parseHostedParam = (
  raw: string | null,
): HostedMockOptions | undefined => {
  if (raw === null) return undefined;
  const out: HostedMockOptions = {};
  for (const t of raw.split(",")) Object.assign(out, TOKENS[t.trim()]);
  return out;
};
