// Design's Screens A, decision 3A: a slim banner on every page while the plan
// has the instance read-only, with the reason in the shared plan copy. Owners
// and admins get a link to Plan and billing; everyone else is told whom to ask
// (the copy). Sharing and reading still work, so the banner never hides a page.

import type { Me } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { readOnlyCopy } from "../api/errorCopy";
import { AppLink } from "../library/AppLink";
import { Notice } from "./Notice";

export const PLAN_PAGE = "/settings/plan";

export function PlanBanner({
  me,
  className = "",
}: {
  me: Me | null | undefined;
  /** The page's content column, so the banner's edges line up with it. */
  className?: string;
}) {
  const billing = me?.instance.billing;
  if (!billing?.readOnly) return null;
  // Owners and admins reach Plan and billing even while the plan locks the
  // instance (the cap "plan" is only on the other people).
  const admin = me?.user.role === "owner" || me?.user.role === "admin";
  return (
    <div className={`mb-[var(--oa-space-3)] ${className}`}>
      <Notice
        tone="warning"
        compact
        action={
          admin ? (
            <Button size="sm" variant="outline" asChild>
              <AppLink href={PLAN_PAGE}>Plan and billing</AppLink>
            </Button>
          ) : undefined
        }
      >
        {`${billing.reason === "solo_unpaid" ? "Paused." : "Read-only."} ${readOnlyCopy(billing.reason, admin)}`}
      </Notice>
    </div>
  );
}
