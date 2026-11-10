// #1836: when an invite starts the 14-day Business trial, and when it ends.
import { type Me, TRIAL_DAYS } from "@oa/shared";
import { formatDate } from "../settings/date";

/**
 * The server's trialEligible, read off Me: hosted billing is on, the tier is
 * Solo (free before Solo), the Business trial never ran, the plan is active
 * (a paused Solo is view-only, and a past_due one is refused) and the caller
 * isn't capped: on Solo everyone but the owner carries the "plan" cap, which
 * the server refuses an invite on, admins included. trialEndsAt reads null
 * for anyone but owners and admins whether or not a trial ran, so a null
 * status (the billing details are hidden) is never "never ran".
 */
export const trialWouldStart = (me: Me | null | undefined): boolean => {
  const b = me?.instance?.billing;
  return (
    !!b &&
    (b.tier === "solo" || b.tier === "free") &&
    b.status === "active" &&
    (me?.auth?.cap ?? null) === null &&
    b.trialEndsAt === null &&
    !b.readOnly &&
    (b.reason === undefined || b.reason === "solo")
  );
};

/** The day the trial ends if it starts at `now`: TRIAL_DAYS later, as a UTC date. */
export const trialEndsOn = (now = Date.now()): string =>
  formatDate(now + TRIAL_DAYS * 86_400_000) as string;
