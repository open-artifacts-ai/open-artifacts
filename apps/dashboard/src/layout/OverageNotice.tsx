// #2246: extra-creator charges that failed. A notice on every page and on
// Plan and billing for owners and admins (the server sends the field to no one
// else). It never changes access. "Update payment method" opens the billing portal.

import { BillingUrlSchema, type PlanView, R } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api/client";
import { errorCopy } from "../api/errorCopy";
import { useRedirect } from "../auth/redirect";
import { Notice } from "./Notice";
import { toast } from "./toast";

const monthName = (month: string, withYear: boolean) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, 1)).toLocaleString(
    "en-US",
    {
      month: "long",
      timeZone: "UTC",
      ...(withYear ? { year: "numeric" } : {}),
    },
  );
};

const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;

/** "September and October", "August, September and October". */
export function monthList(months: string[]): string {
  // A card added later can settle a month from a past year: name the year then.
  const years = new Set(months.map((m) => m.slice(0, 4)));
  const withYear =
    years.size > 1 || !years.has(String(new Date().getUTCFullYear()));
  const names = months.map((m) => monthName(m, withYear));
  if (names.length === 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function overageCopy(due: NonNullable<PlanView["overageDue"]>): string {
  return `Extra creators for ${monthList(due.months)} are waiting to be charged (${dollars(due.amountCents)}). Check your card to settle it.`;
}

export function OverageNotice({
  due,
  compact = false,
}: {
  due: PlanView["overageDue"];
  compact?: boolean;
}) {
  const redirect = useRedirect();
  const portal = useMutation({
    mutationFn: () => api.send("POST", R.billingPortal, {}, BillingUrlSchema),
    onSuccess: ({ url }) => redirect(url),
    onError: (e: unknown) =>
      toast({
        title: errorCopy(e, "Billing isn't reachable right now."),
        tone: "danger",
      }),
  });
  if (!due) return null;
  return (
    <div data-testid="overage-notice">
      <Notice
        tone="warning"
        compact={compact}
        action={
          <Button
            size="sm"
            variant="outline"
            disabled={portal.isPending}
            onClick={() => portal.mutate()}
          >
            Update payment method
          </Button>
        }
      >
        {overageCopy(due)}
      </Notice>
    </div>
  );
}
