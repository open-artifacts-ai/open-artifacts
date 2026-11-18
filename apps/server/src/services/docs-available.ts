import { planOf } from "@oa/shared";
import { billingOn } from "../billing/plan.js";
import type { Env } from "../env.js";
import { docCreationOpen } from "./doc-switch.js";

/**
 * Whether this deployment creates collaborative docs (#1100): the creation
 * switch (docCreationOpen: DOC_SWITCH, or DOCS_PREVIEW on staging), and a hosted install (Workers for Platforms, always paid) or a
 * self-host on the Workers Paid plan (PLAN=paid).
 */
export const docsAvailable = (
  env: Pick<Env, "HOSTED" | "PLAN" | "DOCS_PREVIEW">,
): boolean =>
  docCreationOpen(env) && (billingOn(env) || planOf(env.PLAN) === "paid");

/** What /me tells the dashboard: absent while the switch is off. */
export const docsState = (
  env: Parameters<typeof docsAvailable>[0],
): "on" | "needs_paid" | undefined =>
  docCreationOpen(env) ? (docsAvailable(env) ? "on" : "needs_paid") : undefined;
