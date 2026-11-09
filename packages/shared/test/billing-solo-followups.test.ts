import { describe, expect, it } from "vitest";
import { PlanLimitDetailsSchema, PlanViewSchema } from "../src/index.js";

describe("PlanLimitDetails tier", () => {
  it("accepts solo, and still accepts free from an older server", () => {
    for (const tier of ["solo", "free"]) {
      expect(
        PlanLimitDetailsSchema.parse({ tier, limit: "data_docs", max: 2 }).tier,
      ).toBe(tier);
    }
    expect(() =>
      PlanLimitDetailsSchema.parse({
        tier: "team",
        limit: "data_docs",
        max: 2,
      }),
    ).toThrow();
  });
});

describe("PlanView soloTrialEndsAt", () => {
  const base = {
    tier: "solo",
    status: "active",
    trialEndsAt: null,
    graceUntil: null,
    readOnly: false,
  };
  it("is optional, nullable and an ISO string", () => {
    expect(PlanViewSchema.parse(base).soloTrialEndsAt).toBeUndefined();
    expect(
      PlanViewSchema.parse({ ...base, soloTrialEndsAt: null }).soloTrialEndsAt,
    ).toBeNull();
    expect(
      PlanViewSchema.parse({
        ...base,
        soloTrialEndsAt: "2026-12-01T00:00:00.000Z",
      }).soloTrialEndsAt,
    ).toBe("2026-12-01T00:00:00.000Z");
    expect(() =>
      PlanViewSchema.parse({ ...base, soloTrialEndsAt: 5 }),
    ).toThrow();
  });
});
