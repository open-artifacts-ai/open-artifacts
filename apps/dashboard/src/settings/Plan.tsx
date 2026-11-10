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
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { errorCopy } from "../api/errorCopy";
import { useRedirect } from "../auth/redirect";
import { useMe } from "../auth/useMe";
import { Notice } from "../layout/Notice";
import { toast } from "../layout/toast";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { formatDate } from "./date";
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
  free: "$1 a month or $10 a year",
  solo: "$1 a month or $10 a year",
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
      solo: "$1 a month or $10 a year, per instance",
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

/**
 * Wraps a shadcn Table: a right-edge fade shows only while the table's scroll
 * box overflows and isn't scrolled to the end, so it says "more this way" and
 * never dims the last column once it is in view.
 */
function ScrollFade({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>(
      '[data-slot="table-container"]',
    );
    if (!el) return;
    const update = () =>
      setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // A content-width change (a font swap) resizes the table, not the box.
    const t = el.querySelector("table");
    if (t) ro.observe(t);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);
  return (
    <div ref={box} className="relative">
      {children}
      {more && (
        <div
          aria-hidden="true"
          data-testid="table-fade"
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-[var(--oa-bg)] to-transparent"
        />
      )}
    </div>
  );
}

const NAMES: Record<Column, string> = {
  solo: "Solo",
  team: "Team",
  business: "Business",
};

/** The comparison on a phone: a block per plan, every row in full. */
function Stacked({ column }: { column: Column }) {
  return (
    <div
      data-testid="compare-stacked"
      className="grid gap-[var(--oa-space-3)] sm:hidden"
    >
      {(["solo", "team", "business"] as const).map((c) => (
        <section
          key={c}
          aria-current={c === column ? "true" : undefined}
          className={`rounded-[var(--oa-radius-md)] border border-[var(--oa-border)] p-[var(--oa-space-3)] ${
            c === column ? "bg-[var(--oa-accent-soft)]" : ""
          }`}
        >
          <h3 className="m-0 text-[length:var(--oa-text-base)] font-semibold">
            {NAMES[c]}
          </h3>
          <dl className="m-0 mt-[var(--oa-space-2)] grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-[var(--oa-space-3)] gap-y-[var(--oa-space-1)]">
            {CMP.map((r) => (
              <Fragment key={r.row}>
                <dt className={muted}>{r.row}</dt>
                <dd className="m-0">{r.cells[c]}</dd>
              </Fragment>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

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
          {!ended && (
            <>
              <dt className={muted}>Price</dt>
              <dd className="m-0">{PRICE[billing.tier]}</dd>
            </>
          )}
        </dl>
        <div className="flex flex-wrap items-center gap-[var(--oa-space-2)]">
          {(paid && !lapsedPaid) || billing.status === "past_due" ? (
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
              <Button
                variant={solo ? "outline" : "default"}
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
          {paid && !lapsedPaid && (
            <span className={muted}>
              Invoices and card are in the billing portal.
            </span>
          )}
        </div>
      </SettingsCard>
      <section
        aria-label="Compare plans"
        className={`relative min-w-0 ${INSET} px-0`}
      >
        <div data-testid="compare-table" className="hidden sm:block">
          <ScrollFade>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead />
                  {(["solo", "team", "business"] as const).map((c) => (
                    <TableHead
                      key={c}
                      aria-current={c === column ? "true" : undefined}
                      className={
                        c === column ? "bg-[var(--oa-accent-soft)]" : ""
                      }
                    >
                      {c === "solo"
                        ? "Solo"
                        : c === "team"
                          ? "Team"
                          : "Business"}
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
                        className={
                          c === column ? "bg-[var(--oa-accent-soft)]" : ""
                        }
                      >
                        {r.cells[c]}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollFade>
        </div>
        <Stacked column={column} />
        <p className={`mt-[var(--oa-space-2)] ${muted}`}>
          Team and Business bill per creator: people who publish or edit live
          data in a month. Viewers are free.
        </p>
      </section>
    </div>
  );
}
