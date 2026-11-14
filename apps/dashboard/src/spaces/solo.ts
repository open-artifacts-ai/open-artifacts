// #2472: on hosted Solo, spaces are hidden behind what they come with. The
// sidebar and /settings/spaces say so and link the plans; the New space
// dialog's refusal stays as the fallback.
import type { Me } from "@oa/shared";
import {
  billingContext,
  MEMBERS_SETTINGS,
  PLAN_SETTINGS,
} from "../api/errorCopy";

/** A hosted instance on Solo (free is Solo's older name). Self-hosted never is. */
export const isHostedSolo = (me: Me | null | undefined): boolean => {
  const tier = me?.instance?.billing?.tier;
  return !!me?.instance?.hosted && (tier === "solo" || tier === "free");
};

export const SOLO_SPACES_TITLE = "Spaces come with Team";
export const SOLO_SPACES_LINE =
  "Shared spaces are part of the Team plan. What you publish stays in Personal.";

export type SoloLink = { label: string; to: string };

export const SEE_PLANS: SoloLink = { label: "See plans", to: PLAN_SETTINGS };

/**
 * The settings page's links: Invite people while the free Team trial is still
 * there to start (planLinks' rule, billingContext's trialNeverRan), then See plans.
 */
export const soloSettingsLinks = (me: Me | null | undefined): SoloLink[] =>
  billingContext(me).trialNeverRan === true
    ? [
        {
          label: "Invite people to start a free 30-day trial",
          to: MEMBERS_SETTINGS,
        },
        SEE_PLANS,
      ]
    : [SEE_PLANS];
