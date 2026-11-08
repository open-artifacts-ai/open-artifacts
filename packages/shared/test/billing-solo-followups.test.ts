import { describe, expect, it } from "vitest";
import { PlanLimitDetailsSchema } from "../src/index.js";

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
