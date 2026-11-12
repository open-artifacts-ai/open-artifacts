// Design's Screens A, decision 3A: a slim banner on every page while the plan
// has the instance read-only, with the reason in the shared plan copy. Owners
// and admins get a link to Plan and billing; everyone else is told whom to ask
// (the copy). Sharing and reading still work, so the banner never hides a page.

import type { Me } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { readOnlyCopy } from "../api/errorCopy";
import { AppLink } from "../library/AppLink";
import { Notice } from "./Notice";
import { OverageNotice } from "./OverageNotice";

export const PLAN_PAGE = "/settings/plan";
/**
 * Where "Email support" goes: the general contact address in the published
 * terms (apps/landing legal). The dashboard has no support address of its own.
 */
export const SUPPORT_EMAIL = "hello@open-artifacts.com";

/**
 * The banner's one button for an owner or admin, by reason (Design, Self-serve
 * screens v6, decision 3): suspended is an operator's stop, so it is an email;
 * billing_unreachable is our outage, so there is nothing for the owner to do.
 */
function ownerAction(reason: unknown) {
  if (reason === "billing_unreachable") return undefined;
  if (reason === "suspended")
    return (
      <Button size="sm" variant="outline" asChild>
        <a href={`mailto:${SUPPORT_EMAIL}`}>Email support</a>
      </Button>
    );
  return (
    <Button size="sm" variant="outline" asChild>
      <AppLink href={PLAN_PAGE}>
        {reason === "lapsed" || reason === "payment_failed"
          ? "Manage billing"
          : "Plan and billing"}
      </AppLink>
    </Button>
  );
}

export function PlanBanner({
  me,
  className = "",
}: {
  me: Me | null | undefined;
  /** The page's content column, so the banner's edges line up with it. */
  className?: string;
}) {
  const billing = me?.instance.billing;
  // Owners and admins reach Plan and billing even while the plan locks the
  // instance (the cap "plan" is only on the other people).
  const admin = me?.user.role === "owner" || me?.user.role === "admin";
  // #2246: unpaid extra-creator charges; the server sends them to admins only.
  const overage =
    admin && billing?.overageDue ? (
      <div className={`mb-[var(--oa-space-3)] ${className}`}>
        <OverageNotice due={billing.overageDue} compact />
      </div>
    ) : null;
  if (!billing?.readOnly) return overage;
  return (
    <>
      {overage}
      <div
        data-testid="plan-banner"
        className={`mb-[var(--oa-space-3)] ${className}`}
      >
        <Notice
          tone="warning"
          compact
          action={admin ? ownerAction(billing.reason) : undefined}
        >
          {readOnlyCopy(billing.reason, admin)}
        </Notice>
      </div>
    </>
  );
}
