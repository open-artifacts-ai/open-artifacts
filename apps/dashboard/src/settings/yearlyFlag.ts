/**
 * Yearly Team and Business ($100 and $250 a creator a year, monthly x10, the
 * user's call 2026-11-11) wait for Stripe prices. Until then the toggle changes
 * Solo only, and nothing shows a price checkout can't charge. Flipping this
 * shows them, asks for a seat count, and sends the interval to checkout. An
 * object so tests can turn it on; production code never writes it.
 */
export const yearlyFlag = { teamBusiness: false };
