// The prices and the words around them, in one place so Billing can adjust the
// rounding and the "billed yearly" wording without touching the page markup.
// The page opens on Yearly: the per-month figure first, the yearly total under it.

export type Plan = {
  name: string;
  blurb: string;
  /** Monthly price in dollars (billed monthly), or null for a free plan. */
  monthly: number | null;
  /** Yearly total in dollars, or null for a free plan. */
  yearly: number | null;
  /** True when the plan is priced per creator. */
  perCreator: boolean;
  cta: string;
  primary: boolean;
  pop: boolean;
};

export const PLAN_LIST: Omit<Plan, "cta">[] = [
  {
    name: "Solo",
    blurb: "You and your agents",
    monthly: 1,
    yearly: 10,
    perCreator: false,
    primary: true,
    pop: false,
  },
  {
    name: "Team",
    blurb: "Invite your team",
    monthly: 10,
    yearly: 100,
    perCreator: true,
    primary: true,
    pop: true,
  },
  {
    name: "Business",
    blurb: "Controls for your company",
    monthly: 25,
    yearly: 250,
    perCreator: true,
    primary: false,
    pop: false,
  },
  {
    name: "Self-host",
    blurb: "In your own account",
    monthly: null,
    yearly: null,
    perCreator: false,
    primary: false,
    pop: false,
  },
];

/** Whole dollars read "$10"; anything else reads to the cent, "$0.83". */
export const money = (n: number) =>
  Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;

/** The yearly total spread over twelve months, rounded to the cent. */
export const perMonth = (yearly: number) =>
  Math.round((yearly / 12) * 100) / 100;

export const WORDS = {
  /** After the price. */
  unit: (perCreator: boolean) =>
    perCreator ? "per creator a month" : "a month",
  /** Under the price when billed monthly. */
  billedMonthly: "Billed monthly",
  /** Under the price when billed yearly. */
  billedYearly: (yearly: number, perCreator: boolean) =>
    perCreator
      ? `${money(yearly)} per creator, billed yearly`
      : `${money(yearly)} billed yearly`,
  selfHost: "Open source, MIT",
  waitlist:
    "Hosted plans are invite-only during the beta. Join the waitlist and we'll email you when your instance is ready.",
  note: "Solo is per account; Team and Business are per creator. A creator is someone who publishes or edits; viewers and commenters are free. Solo is free for 30 days, no card. Team starts with a 30-day trial when you invite someone.",
};

/** What a paid plan shows in each billing period (the page opens on Yearly). */
export function priceStrings(
  p: Pick<Plan, "monthly" | "yearly" | "perCreator">,
) {
  const monthly = p.monthly as number;
  const yearly = p.yearly as number;
  return {
    price: { m: money(monthly), y: money(perMonth(yearly)) },
    bill: {
      m: WORDS.billedMonthly,
      y: WORDS.billedYearly(yearly, p.perCreator),
    },
    unit: WORDS.unit(p.perCreator),
  };
}
