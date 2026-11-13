import { describe, expect, it } from "vitest";
import { PLAN_PRICES, planPriceDisplay } from "../src/index.js";

describe("PLAN_PRICES", () => {
  it("holds the cents, per creator for Team and Business", () => {
    expect(PLAN_PRICES).toEqual({
      solo: { month: 100, year: 1000 },
      team: { month: 1000, year: 10_000 },
      business: { month: 2500, year: 25_000 },
    });
  });
});

describe("planPriceDisplay", () => {
  it("monthly shows the monthly price", () => {
    expect(planPriceDisplay("solo", "month")).toEqual({
      big: "$1",
      unit: "a month",
      sub: null,
    });
    expect(planPriceDisplay("team", "month")).toMatchObject({
      big: "$10",
      unit: "per creator a month",
    });
    expect(planPriceDisplay("business", "month")).toMatchObject({
      big: "$25",
      unit: "per creator a month",
    });
  });

  it("yearly shows the per-month figure rounded down, and what is billed", () => {
    expect(planPriceDisplay("solo", "year")).toEqual({
      big: "$0.83",
      unit: "a month",
      sub: "$10 billed yearly",
    });
    expect(planPriceDisplay("team", "year")).toEqual({
      big: "$8.33",
      unit: "per creator a month",
      sub: "$100 per creator, billed yearly",
    });
    expect(planPriceDisplay("business", "year")).toEqual({
      big: "$20.83",
      unit: "per creator a month",
      sub: "$250 per creator, billed yearly",
    });
  });
});
