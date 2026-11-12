// The plan prices (#2237), in cents: one table for the dashboard's cards and
// the seat dialog's total. Team and Business are per creator. The charge itself
// is Stripe's price; this is what we display.
export type PricedTier = "solo" | "team" | "business";
export type PriceInterval = "month" | "year";

export const PLAN_PRICES: Record<PricedTier, Record<PriceInterval, number>> = {
  solo: { month: 100, year: 1000 },
  team: { month: 1000, year: 10_000 },
  business: { month: 2500, year: 25_000 },
};

/** Whole dollars read "$10"; anything else reads "$8.33". */
export const formatCents = (cents: number): string =>
  cents % 100 === 0
    ? `$${cents / 100}`
    : `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

/**
 * What a plan card shows. Yearly leads with the per-month figure (the yearly
 * price over 12, rounded down to the cent) and says what is billed.
 */
export const planPriceDisplay = (
  tier: PricedTier,
  interval: PriceInterval,
): { big: string; unit: string; sub: string | null } => {
  const perCreator = tier !== "solo";
  const unit = perCreator ? "per creator a month" : "a month";
  if (interval === "month")
    return { big: formatCents(PLAN_PRICES[tier].month), unit, sub: null };
  const year = PLAN_PRICES[tier].year;
  return {
    big: formatCents(Math.floor(year / 12)),
    unit,
    sub: `${formatCents(year)}${perCreator ? " per creator," : ""} billed yearly`,
  };
};
