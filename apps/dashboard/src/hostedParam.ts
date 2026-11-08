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
  // Solo after a used Business trial: trialEndsAt is the past trial, so no note.
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
  admin: { actAs: "admin" },
  "guest-notices": { selfHosted: true, guestShares: 2, guestOwners: 2 },
  "guest-departed": {
    selfHosted: true,
    guestShares: 2,
    guestOwners: 2,
    departedGuestOwner: true,
  },
  "spaces-on": { spaces: true },
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
 * scope-missing, customer-mismatch, trial, solo, solo-paused, team, business, frozen, sync-off,
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
