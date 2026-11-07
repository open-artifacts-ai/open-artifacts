// Settings > Plan and billing (#953, Design's Screens A, option 1A): one plan
// card with its status and the two billing buttons, then a compact comparison.
// Owners and admins only, and they reach it even while the plan locks the
// instance. The card shows only what Me.instance.billing carries: no invoice
// or card data (that is the Stripe portal).
import {
  type BillingCheckoutInput,
  type BillingTier,
  BillingUrlSchema,
  type PlanView,
  R,
} from "@oa/shared";
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@oa/ui/shadcn";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api/client";
import { errorCopy } from "../api/errorCopy";
import { useRedirect } from "../auth/redirect";
import { useMe } from "../auth/useMe";
import { Notice } from "../layout/Notice";
import { toast } from "../layout/toast";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { INSET, muted, SettingsCard, STACK } from "./ui";

type Buy = Pick<BillingCheckoutInput, "tier" | "interval">;
type Column = "solo" | "team" | "business";

const NAME: Record<BillingTier, string> = {
  free: "Solo",
  solo: "Solo",
  trial: "Business trial",
  team: "Team",
  business: "Business",
};
const PRICE: Record<BillingTier, string> = {
  free: "$1 a month or $12 a year",
  solo: "$1 a month or $12 a year",
  trial: "Free for 14 days",
  team: "$10 per creator per month",
  business: "$25 per creator per month",
};
/** The tier's column in the comparison; the trial is Business until it ends. */
const COLUMN: Record<BillingTier, Column> = {
  free: "solo",
  solo: "solo",
  trial: "business",
  team: "team",
  business: "business",
};
const CMP: { row: string; cells: Record<Column, string> }[] = [
  {
    row: "Price",
    cells: {
      solo: "$1 a month or $12 a year",
      team: "$10 per creator",
      business: "$25 per creator",
    },
  },
  {
    row: "People",
    cells: {
      solo: "You and your agents",
      team: "Invite people",
      business: "Invite people",
    },
  },
  {
    row: "Share with anyone",
    cells: { solo: "Yes", team: "Yes", business: "Yes" },
  },
  { row: "Spaces", cells: { solo: "No", team: "Yes", business: "Yes" } },
  {
    row: "Directory sync",
    cells: { solo: "No", team: "No", business: "Yes" },
  },
];

const date = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
    : null;

type Status = {
  label: string;
  tone: "ok" | "warn" | "bad" | "info";
};

/** The status pill and the one note under it, from the plan alone. */
export const planStatus = (
  b: PlanView,
): { pill: Status; note?: { tone: "warning" | "info"; text: string } } => {
  const solo = b.tier === "solo" || b.tier === "free";
  // Read-only states: the app-wide banner already says why, so the card
  // shows only the status.
  if (b.reason === "solo_unpaid")
    return { pill: { label: "Paused", tone: "warn" } };
  if (b.readOnly)
    return {
      pill: {
        label: b.reason === "suspended" ? "Suspended" : "Read-only",
        tone: "bad",
      },
    };
  if (b.status === "past_due")
    return {
      pill: { label: "Past due", tone: "warn" },
      note: {
        tone: "warning",
        text: `Payment failed. Update your card${
          b.graceUntil ? ` by ${date(b.graceUntil)}` : ""
        }. After that, this instance becomes read-only.`,
      },
    };
  if ((b.tier === "trial" || solo) && b.trialEndsAt)
    return {
      pill: { label: "Trial", tone: "info" },
      note: {
        tone: "info",
        text: `Trial ends ${date(b.trialEndsAt)}.${
          b.tier === "trial" ? " Everything in Business is on." : ""
        }`,
      },
    };
  return { pill: { label: "Active", tone: "ok" } };
};

const PILL: Record<Status["tone"], string> = {
  ok: "bg-[var(--oa-success-soft)] text-[var(--oa-success)]",
  warn: "bg-[var(--oa-warning-soft)] text-[var(--oa-warning)]",
  bad: "bg-[var(--oa-danger-soft)] text-[var(--oa-danger)]",
  info: "bg-[var(--oa-accent-soft)] text-[var(--oa-accent-fg)]",
};

export function Plan() {
  useDocumentTitle("Plan and billing");
  const state = useMe();
  const redirect = useRedirect();
  // Checkout and the portal answer a Stripe-hosted URL; we only open it.
  const go = useMutation({
    mutationFn: (to: Buy | "portal") =>
      to === "portal"
        ? api.send("POST", R.billingPortal, {}, BillingUrlSchema)
        : api.send("POST", R.billingCheckout, to, BillingUrlSchema),
    onSuccess: ({ url }) => redirect(url),
    onError: (e: unknown) =>
      toast({
        title: errorCopy(e, "Billing isn't reachable right now."),
        tone: "danger",
      }),
  });
  const billing =
    state.status === "authed" ? state.me.instance.billing : undefined;
  if (!billing) {
    // Self-hosted installs have no plan; there is nothing to show.
    return (
      <div className={STACK}>
        <p className={muted}>This install has no plan to manage.</p>
      </div>
    );
  }
  const { pill, note } = planStatus(billing);
  const column = COLUMN[billing.tier];
  const paid = billing.tier === "team" || billing.tier === "business";
  const busy = go.isPending;
  return (
    <div className={STACK}>
      <SettingsCard id="plan-card" title="Plan and billing">
        <div className="flex flex-wrap items-center gap-[var(--oa-space-2)]">
          <b className="text-[length:var(--oa-text-lg)]">
            {NAME[billing.tier]}
          </b>
          <Badge variant="outline" className={PILL[pill.tone]}>
            {pill.label}
          </Badge>
        </div>
        {note && <Notice tone={note.tone}>{note.text}</Notice>}
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-[var(--oa-space-4)] gap-y-[var(--oa-space-1)]">
          {billing.creatorsThisMonth !== undefined && (
            <>
              <dt className={muted}>Creators this month</dt>
              <dd className="m-0">{billing.creatorsThisMonth}</dd>
            </>
          )}
          <dt className={muted}>Price</dt>
          <dd className="m-0">{PRICE[billing.tier]}</dd>
        </dl>
        <div className="flex flex-wrap items-center gap-[var(--oa-space-2)]">
          {paid || billing.status === "past_due" ? (
            <Button disabled={busy} onClick={() => go.mutate("portal")}>
              Manage billing
            </Button>
          ) : (
            <>
              {column === "solo" && (
                <>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      go.mutate({ tier: "solo", interval: "month" })
                    }
                  >
                    Pay $1/month
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      go.mutate({ tier: "solo", interval: "year" })
                    }
                  >
                    Pay $12/year
                  </Button>
                </>
              )}
              <Button
                variant={column === "solo" ? "outline" : "default"}
                disabled={busy}
                onClick={() => go.mutate({ tier: "business" })}
              >
                Upgrade to Business
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => go.mutate({ tier: "team" })}
              >
                Upgrade to Team
              </Button>
            </>
          )}
          {paid && (
            <span className={muted}>
              Invoices and card are in the billing portal.
            </span>
          )}
        </div>
      </SettingsCard>
      <section aria-label="Compare plans" className={`min-w-0 ${INSET} px-0`}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead />
              {(["solo", "team", "business"] as const).map((c) => (
                <TableHead
                  key={c}
                  aria-current={c === column ? "true" : undefined}
                  className={c === column ? "bg-[var(--oa-accent-soft)]" : ""}
                >
                  {c === "solo" ? "Solo" : c === "team" ? "Team" : "Business"}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {CMP.map((r) => (
              <TableRow key={r.row}>
                <TableHead scope="row">{r.row}</TableHead>
                {(["solo", "team", "business"] as const).map((c) => (
                  <TableCell
                    key={c}
                    className={c === column ? "bg-[var(--oa-accent-soft)]" : ""}
                  >
                    {r.cells[c]}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className={`mt-[var(--oa-space-2)] ${muted}`}>
          Billed per creator: people who publish or edit live data in a month.
          Viewers are free.
        </p>
      </section>
    </div>
  );
}
