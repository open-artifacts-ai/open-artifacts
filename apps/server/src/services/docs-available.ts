import { planOf } from "@oa/shared";
import { billingOn } from "../billing/plan.js";
import type { Env } from "../env.js";
import { DOC_SWITCH } from "./doc-switch.js";

/**
 * Whether this deployment creates collaborative docs (#1100): the DOC_SWITCH
 * switch, and a hosted install (Workers for Platforms, always paid) or a
 * self-host on the Workers Paid plan (PLAN=paid).
 */
/** What /me tells the dashboard: absent while the switch is off. */
export const docsState = (
  env: Pick<Env, "HOSTED" | "PLAN">,
): "on" | "needs_paid" | undefined =>
  DOC_SWITCH.creation ? (docsAvailable(env) ? "on" : "needs_paid") : undefined;

export const docsAvailable = (env: Pick<Env, "HOSTED" | "PLAN">): boolean =>
  DOC_SWITCH.creation && (billingOn(env) || planOf(env.PLAN) === "paid");
