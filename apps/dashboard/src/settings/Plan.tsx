// Settings > Plan and billing (#953, Design's Screens A, option 1A): one plan
// card with its status and the two billing buttons, then the plan cards and
// comparison with a Monthly/Yearly toggle (#2007, PlanCompare.tsx).
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
import { Badge, Button } from "@oa/ui/shadcn";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api/client";
import { errorCopy } from "../api/errorCopy";
import { useRedirect } from "../auth/redirect";
import { useMe } from "../auth/useMe";
import { Notice } from "../layout/Notice";
import { toast } from "../layout/toast";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { formatDate } from "./date";
import { type Column, PlanCompare } from "./PlanCompare";
import { muted, SettingsCard, STACK } from "./ui";

type Buy = Pick<BillingCheckoutInput, "tier" | "interval">;

const NAME: Record<BillingTier, string> = {
  free: "Solo",
  solo: "Solo",
  trial: "Business trial",
  team: "Team",
  business: "Business",
};
const PRICE: Record<BillingTier, string> = {
  free: "$1 a month or $10 a year",
  solo: "$1 a month or $10 a year",
  trial: "Free for 30 days",
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
const date = formatDate;

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
  // PlanView carries no end date for a lapsed plan (trialEndsAt and graceUntil
  // are the trial's and the grace period's), so the note names none.
  if (b.status === "lapsed" && (b.tier === "team" || b.tier === "business"))
    return {
      pill: { label: "Read-only", tone: "bad" },
      note: {
        tone: "warning",
        text: `Your ${NAME[b.tier]} plan ended. Restart it to edit again.`,
      },
    };
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
  // trialEndsAt is the Business trial's only: a Solo row with one is a used
  // Business trial and shows no note. The Solo month has its own date, and a
  // date already past (a paid Solo) shows nothing.
  if (b.tier === "trial" && b.trialEndsAt)
    return {
      pill: { label: "Trial", tone: "info" },
      note: {
        tone: "info",
        text: `Trial ends ${date(b.trialEndsAt)}. Everything in Business is on.`,
      },
    };
  if (solo && b.soloTrialEndsAt && Date.parse(b.soloTrialEndsAt) > Date.now())
    return {
      // Not "Trial": that is the Business trial's word.
      pill: { label: "Free month", tone: "info" },
      note: {
        tone: "info",
        text: `Your free month ends ${date(b.soloTrialEndsAt)}. Then $1/month or $10/year.`,
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
  const solo = column === "solo";
  const ended = billing.readOnly && billing.reason === "trial_ended";
  const paid = billing.tier === "team" || billing.tier === "business";
  // A lapsed paid plan restarts through Checkout: the portal can't revive a
  // canceled subscription.
  const lapsedPaid = paid && billing.status === "lapsed";
  const busy = go.isPending;
  // The portal needs a Stripe customer. A provisioned or comped plan has
  // none (hasCustomer false): no Manage billing, since billing would refuse.
  // Absent means billing's answer predates the field: keep the button.
  // A Solo reaches the portal only with a customer explicitly reported (never
  // from an absent field) and a live subscription: active or past_due.
  const soloSubscriber =
    solo &&
    billing.hasCustomer === true &&
    (billing.status === "active" || billing.status === "past_due");
  const portal =
    (paid && !lapsedPaid) || billing.status === "past_due" || soloSubscriber;
  const operatorPlan = portal && billing.hasCustomer === false;
  return (
    <div className={STACK}>
      <SettingsCard id="plan-card" title="Plan and billing">
        <div className="flex flex-wrap items-center gap-[var(--oa-space-2)]">
          <b className="text-[length:var(--oa-text-lg)]">
            {ended ? "Trial ended" : NAME[billing.tier]}
          </b>
          <Badge variant="outline" className={PILL[pill.tone]}>
            {pill.label}
          </Badge>
        </div>
        {note && <Notice tone={note.tone}>{note.text}</Notice>}
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-[var(--oa-space-4)] gap-y-[var(--oa-space-1)]">
          {!solo && billing.creatorsThisMonth !== undefined && (
            <>
              <dt className={muted}>Creators this month</dt>
              <dd className="m-0">{billing.creatorsThisMonth}</dd>
            </>
          )}
          {!ended && !operatorPlan && (
            <>
              <dt className={muted}>Price</dt>
              <dd className="m-0">{PRICE[billing.tier]}</dd>
            </>
          )}
        </dl>
        <div className="flex flex-wrap items-center gap-[var(--oa-space-2)]">
          {operatorPlan ? (
            <span className={muted}>
              Open Artifacts set up this plan for you, so there&apos;s nothing
              to pay or manage here.
            </span>
          ) : portal ? (
            <Button disabled={busy} onClick={() => go.mutate("portal")}>
              Manage billing
            </Button>
          ) : lapsedPaid ? (
            (["team", "business"] as const).map((t) => (
              <Button
                key={t}
                variant={t === billing.tier ? "default" : "outline"}
                disabled={busy}
                onClick={() => go.mutate({ tier: t })}
              >
                {t === billing.tier
                  ? `Restart ${NAME[t]}`
                  : `Switch to ${NAME[t]}`}
              </Button>
            ))
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
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      go.mutate({ tier: "solo", interval: "year" })
                    }
                  >
                    Pay $10/year
                  </Button>
                </>
              )}
            </>
          )}
          {paid && !lapsedPaid && !operatorPlan && (
            <span className={muted}>
              Invoices and card are in the billing portal.
            </span>
          )}
        </div>
      </SettingsCard>
      <PlanCompare
        column={column}
        trial={billing.tier === "trial"}
        busy={busy}
        upgrade={
          operatorPlan || lapsedPaid
            ? undefined
            : // A paid plan changes in the billing portal, never a second checkout.
              portal
              ? () => go.mutate("portal")
              : (tier) => go.mutate({ tier })
        }
      />
    </div>
  );
}
