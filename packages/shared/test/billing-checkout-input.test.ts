import { describe, expect, it } from "vitest";
import { BillingCheckoutInputSchema as S } from "../src/index.js";

const ok = (v: unknown) => S.safeParse(v).success;

describe("BillingCheckoutInputSchema", () => {
  it("solo needs an interval and refuses seats", () => {
    expect(ok({ tier: "solo", interval: "month" })).toBe(true);
    expect(ok({ tier: "solo", interval: "year" })).toBe(true);
    expect(ok({ tier: "solo" })).toBe(false);
    expect(ok({ tier: "solo", interval: "year", seats: 3 })).toBe(false);
  });

  it("team and business: interval optional, month needs no seats", () => {
    for (const tier of ["team", "business"]) {
      expect(ok({ tier })).toBe(true);
      expect(ok({ tier, interval: "month" })).toBe(true);
      expect(ok({ tier, seats: 3 })).toBe(false);
      expect(ok({ tier, interval: "month", seats: 3 })).toBe(false);
    }
  });

  it("team and business yearly need seats 1..10000", () => {
    for (const tier of ["team", "business"]) {
      expect(ok({ tier, interval: "year" })).toBe(false);
      expect(ok({ tier, interval: "year", seats: 1 })).toBe(true);
      expect(ok({ tier, interval: "year", seats: 10_000 })).toBe(true);
      expect(ok({ tier, interval: "year", seats: 0 })).toBe(false);
      expect(ok({ tier, interval: "year", seats: 10_001 })).toBe(false);
      expect(ok({ tier, interval: "year", seats: 2.5 })).toBe(false);
      expect(ok({ tier, interval: "year", seats: "3" })).toBe(false);
    }
  });

  it("refuses unknown keys, tiers and intervals", () => {
    expect(ok({ tier: "team", extra: 1 })).toBe(false);
    expect(ok({ tier: "free" })).toBe(false);
    expect(ok({ tier: "solo", interval: "week" })).toBe(false);
  });
});
