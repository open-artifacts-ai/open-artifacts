import {
  BillingCheckoutInputSchema,
  type BillingUrl,
  type BillingUsage,
  R,
} from "@oa/shared";
import { z } from "zod";
import { caller, capOfCaller, requireUser } from "../auth/authz.js";
import { orgCan } from "../auth/policy.js";
import { monthOf, sendUsage } from "../billing/creators.js";
import { billingOn } from "../billing/plan.js";
import {
  BillingUnavailableError,
  billingCall,
  CHECKOUT_PATH,
  PORTAL_PATH,
} from "../billing/transport.js";
import { jsonBody } from "../http/body.js";
import { ApiError } from "../http/errors.js";
import { logWarn } from "../log.js";
import type { AppType } from "./index.js";

// Self-serve billing for the org owner and admins, hosted only (the billing
// plan cap included: a locked admin can still pay; guests, restricted
// members and members never): a Stripe Checkout or Customer Portal URL from
// billing (signed POST /checkout and /portal through the BILLING gate; the
// billing Worker holds the Stripe key and passes its own URLs), and this
// month's usage report on demand. Cookie writes need X-OA-Request: 1
// (csrf()); other callers are refused by the route policy (404) and
// readOnlyCap. The answer to the dashboard is only the Stripe URL.
// Dependency: /checkout and /portal are Platform's routes (#849's gate
// allowlist); until they ship, these answer 503 billing_unavailable.

/** Stripe's hosted pages: the only URLs these routes hand out. */
const STRIPE_URL = /^https:\/\/(checkout|billing)\.stripe\.com\//;
const UrlAnswerSchema = z.object({ url: z.string().regex(STRIPE_URL) });

const unavailable = () =>
  new ApiError("billing_unavailable", "Billing is unavailable; try again");

/** Hosted, and the org owner or an admin (the plan cap included: they can always pay); else 404 (route hidden). */
function requireBillingManager(c: Parameters<typeof requireUser>[0]) {
  const user = requireUser(c);
  if (
    !billingOn(c.env) ||
    !orgCan(user, "billing.manage", { cap: capOfCaller(caller(c)) })
  )
    throw new ApiError("not_found", "Not found");
  return user;
}

async function stripeUrl(
  c: Parameters<typeof requireUser>[0],
  path: string,
  fields: Record<string, unknown>,
): Promise<BillingUrl> {
  try {
    const r = UrlAnswerSchema.safeParse(
      await billingCall(c.env, path, fields, Date.now()),
    );
    if (!r.success) throw new BillingUnavailableError("bad_answer");
    return { url: r.data.url };
  } catch (e) {
    const why = e instanceof BillingUnavailableError ? e.why : "error";
    logWarn("billing_url_failed", undefined, { route: path, why });
    throw unavailable();
  }
}

export function mountBilling(app: AppType): void {
  app.post(R.billingCheckout, async (c) => {
    requireBillingManager(c);
    const { tier } = await jsonBody(c, BillingCheckoutInputSchema);
    return c.json(await stripeUrl(c, CHECKOUT_PATH, { tier }));
  });

  app.post(R.billingPortal, async (c) => {
    requireBillingManager(c);
    return c.json(await stripeUrl(c, PORTAL_PATH, {}));
  });

  app.post(R.billingUsage, async (c) => {
    requireBillingManager(c);
    try {
      const out: BillingUsage = await sendUsage(
        c.env,
        monthOf(Date.now()),
        Date.now(),
      );
      return c.json({ month: out.month, count: out.count });
    } catch (e) {
      const why = e instanceof BillingUnavailableError ? e.why : "error";
      logWarn("billing_usage_failed", undefined, { why });
      throw unavailable();
    }
  });
}
