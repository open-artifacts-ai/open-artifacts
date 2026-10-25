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
  team: { tier: "team" },
  business: { tier: "business" },
  frozen: { directory: "frozen" },
  "sync-off": { directory: "off" },
  admin: { actAs: "admin" },
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
 * scope-missing, customer-mismatch, trial, team, business, frozen, sync-off,
 * admin (you are an admin, not the owner), break-glass and break-glass-stale
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
