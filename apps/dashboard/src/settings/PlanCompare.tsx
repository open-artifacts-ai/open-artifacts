// #2007, Design's pricing A (Settings version): a Monthly/Yearly toggle, three
// plan cards, then the grouped comparison table with Team tinted. The current
// plan's card says so; higher plans offer the existing upgrade; lower plans
// have no button. Yearly Team and Business prices are proposed until the user
// confirms them and Billing makes them: until then they show monthly prices.

import { formatCents, PLAN_PRICES, planPriceDisplay } from "@oa/shared";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@oa/ui/shadcn";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { THAW_COPY } from "../layout/thawCopy";
import { muted } from "./ui";

export type Column = "solo" | "team" | "business";
export type Interval = "month" | "year";

const SEATS_MAX = 10_000;

const ORDER: readonly Column[] = ["solo", "team", "business"];
const NAMES: Record<Column, string> = {
  solo: "Solo",
  team: "Team",
  business: "Business",
};
const WHO: Record<Column, string> = {
  solo: "You and your agents",
  team: "Invite your team",
  business: "Controls for your company",
};
/**
 * A card's price from the shared table (#2237). Yearly leads with the monthly
 * figure and says what is billed; monthly points at the yearly price when
 * there is one. Team and Business have no yearly price until billing reports them.
 */
const cardPrice = (
  c: Column,
  interval: Interval,
  yearlyOn: boolean,
): { amount: string; unit: string; lines: string[] } => {
  const yearly = interval === "year" && (c === "solo" || yearlyOn);
  const d = planPriceDisplay(c, yearly ? "year" : "month");
  if (yearly)
    return {
      amount: d.big,
      unit: d.unit,
      lines: [d.sub ?? "", "2 months free"],
    };
  const hasYearly = c === "solo" || yearlyOn;
  return {
    amount: d.big,
    unit: d.unit,
    lines: [
      hasYearly
        ? `or ${formatCents(PLAN_PRICES[c].year)}${c === "solo" ? "" : " per creator"} a year`
        : "Billed monthly",
    ],
  };
};
const POINTS: Record<Column, string[]> = {
  solo: [
    "Artifacts, versions and restore",
    "Comments, asks and live artifacts",
    "Share with anyone",
  ],
  team: [
    "Everything in Solo",
    "Invite people; viewers are free",
    "Shared spaces and company login",
  ],
  business: [
    "Everything in Team",
    "Google group sync",
    "Outside-sharing controls and audit log",
    "Custom domain",
  ],
};
const GROUPS: { title: string; rows: { row: string; on: Column[] }[] }[] = [
  {
    title: "Work with agents",
    rows: [
      {
        row: "Artifacts, versions and restore",
        on: ["solo", "team", "business"],
      },
      {
        row: "Comments, @-mentions and asks",
        on: ["solo", "team", "business"],
      },
      {
        row: "Live artifacts (polls, checklists, trackers)",
        on: ["solo", "team", "business"],
      },
      {
        row: "Agents that work together (the bus)",
        on: ["solo", "team", "business"],
      },
    ],
  },
  {
    title: "People",
    rows: [
      {
        row: "Share with anyone, viewers free",
        on: ["solo", "team", "business"],
      },
      { row: "Invite people as members", on: ["team", "business"] },
      { row: "Shared spaces", on: ["team", "business"] },
      { row: "Company login", on: ["team", "business"] },
    ],
  },
  {
    title: "Admin and security",
    rows: [
      { row: "Google group sync", on: ["business"] },
      { row: "Outside-sharing controls", on: ["business"] },
      { row: "Audit log", on: ["business"] },
      { row: "Custom domain", on: ["business"] },
    ],
  },
];
/** Team is the plan for most teams: its card is marked and its column tinted. */
const TINT = "bg-[var(--oa-accent-soft)]";

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

function Toggle({
  value,
  onChange,
  yearly,
}: {
  value: Interval;
  onChange: (v: Interval) => void;
  yearly: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-[var(--oa-space-2)]">
      <fieldset className="m-0 inline-flex rounded-full border border-[var(--oa-border)] p-[2px]">
        <legend className="sr-only">Billing period</legend>
        {(["month", "year"] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={value === v}
            onClick={() => onChange(v)}
            className="cursor-pointer rounded-full border-0 bg-transparent px-[var(--oa-space-3)] py-[4px] text-[length:var(--oa-text-sm)] font-medium text-muted-foreground aria-pressed:bg-foreground aria-pressed:text-background"
          >
            {v === "month" ? "Monthly" : "Yearly"}
          </button>
        ))}
      </fieldset>
      <span className="text-[length:var(--oa-text-sm)] font-medium text-[var(--oa-success)]">
        {yearly ? "2 months free" : "2 months free on Solo"}
      </span>
    </div>
  );
}

const parseSeats = (raw: string): number | null => {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= SEATS_MAX ? n : null;
};

/** The yearly seat count: yearly Team and Business bill a fixed number of creators. */
function SeatStep({
  tier,
  initial,
  busy,
  onCancel,
  onClosed,
  onContinue,
}: {
  tier: "team" | "business";
  initial: number;
  busy: boolean;
  onCancel: () => void;
  /** After the dialog closes: put focus back on the button that opened it. */
  onClosed: () => void;
  onContinue: (seats: number) => void;
}) {
  const [raw, setRaw] = useState(String(Math.max(1, initial)));
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const seats = parseSeats(raw);
  const each = PLAN_PRICES[tier].year / 100;
  const showError = invalid && seats === null;
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      {/* Phones: pinned near the top so the field stays above the keyboard. */}
      <DialogContent
        className="max-sm:top-4 max-sm:translate-y-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          input.current?.focus();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          onClosed();
        }}
      >
        <form
          noValidate
          className="grid gap-[var(--oa-space-2)]"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            if (seats === null) {
              setInvalid(true);
              return;
            }
            onContinue(seats);
          }}
        >
          <DialogHeader>
            <DialogTitle>How many creators on {NAMES[tier]}?</DialogTitle>
            <DialogDescription>
              Creators are people who publish or edit live data. Viewers are
              free. You can change this later in billing.
            </DialogDescription>
          </DialogHeader>
          <Label htmlFor="seat-count">Creators</Label>
          <Input
            id="seat-count"
            ref={input}
            type="number"
            inputMode="numeric"
            min={1}
            max={SEATS_MAX}
            step={1}
            value={raw}
            aria-invalid={showError}
            aria-describedby="seat-help"
            onChange={(e) => {
              setRaw(e.target.value);
              setInvalid(false);
            }}
            className="max-w-[10rem]"
          />
          <p
            id="seat-help"
            role={showError ? "alert" : undefined}
            className={`m-0 ${showError ? "text-[var(--oa-danger)]" : muted}`}
          >
            {showError
              ? `Enter a whole number from 1 to ${SEATS_MAX.toLocaleString("en-US")}.`
              : seats !== null
                ? `${seats.toLocaleString("en-US")} ${seats === 1 ? "creator" : "creators"} × $${each} = $${(seats * each).toLocaleString("en-US")} a year`
                : "Whole numbers from 1 to 10,000."}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PlanCompare({
  column,
  upgrade,
  busy,
  trial = false,
  seatsDefault,
  yearly: yearlyOn = false,
  pendingReverts = 0,
}: {
  /** The current plan's column (the invite trial is Team, #2113). */
  column: Column;
  /** Start the existing upgrade flow; absent: no buttons (can't buy here). */
  upgrade?: (tier: "team" | "business", seats?: number) => void;
  busy: boolean;
  /** The Team trial: nothing is paid yet, so both upgrades show and Team says "Your trial". */
  trial?: boolean;
  /**
   * Set when an upgrade goes to Checkout: with yearly Team or Business on, it
   * first asks how many creators, starting from this count. Absent (the portal
   * path) never asks.
   */
  seatsDefault?: number;
  /** Billing says yearly Team and Business prices exist (billing.yearlyTeamBusiness); off: Solo only. */
  yearly?: boolean;
  /** Synced people whose changed roles go back to their group's on Business (#2150); above 0, Upgrade to Business confirms first. */
  pendingReverts?: number;
}) {
  const [interval, setInterval] = useState<Interval>("year");
  const [asking, setAsking] = useState<"team" | "business" | null>(null);
  const [thawAsk, setThawAsk] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  // A plan change (a billing refetch made this Team) or a lost buy path ends the
  // step; reopening starts again from the default.
  const canBuy = upgrade !== undefined && seatsDefault !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are the triggers
  useEffect(() => {
    setAsking(null);
    setThawAsk(false);
  }, [column, trial, canBuy]);
  const start = (c: "team" | "business") => {
    if (yearlyOn && interval === "year" && seatsDefault !== undefined) {
      setAsking(c);
      return;
    }
    // Monthly sends the tier alone: the server adds the creator count.
    upgrade?.(c);
  };
  // Buttons rank from what is paid for: a trial has paid for nothing yet.
  const rank = trial ? 0 : ORDER.indexOf(column);
  return (
    <section
      aria-label="Compare plans"
      className="grid min-w-0 gap-[var(--oa-space-4)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-[var(--oa-space-2)]">
        <p className={`m-0 ${muted}`}>
          Viewers and sharing are free on every plan.
        </p>
        <Toggle
          value={interval}
          onChange={(v) => {
            setInterval(v);
            setAsking(null);
          }}
          yearly={yearlyOn}
        />
      </div>
      <div className="grid gap-[var(--oa-space-3)] md:grid-cols-3">
        {ORDER.map((c, i) => {
          // Team and Business have no yearly price checkout can charge yet: monthly under both.
          const p = cardPrice(c, interval, yearlyOn);
          const current = c === column;
          return (
            <section
              key={c}
              aria-labelledby={`plan-${c}`}
              aria-current={current ? "true" : undefined}
              data-testid={`plan-card-${c}`}
              className={`flex min-w-0 flex-col gap-[var(--oa-space-3)] rounded-[var(--oa-radius-md)] border p-[var(--oa-space-4)] ${
                c === "team"
                  ? "border-[var(--oa-accent)]"
                  : "border-[var(--oa-border)]"
              } bg-card`}
            >
              {/* One min-height: Team's chips would otherwise push its price lower. */}
              <div className="flex min-h-7 flex-wrap items-center gap-[var(--oa-space-2)]">
                <h3
                  id={`plan-${c}`}
                  className="m-0 text-[length:var(--oa-text-base)] font-semibold"
                >
                  {NAMES[c]}
                </h3>
                {trial && current && (
                  <Badge variant="outline">Your trial</Badge>
                )}
                {c === "team" && (
                  <Badge
                    variant="outline"
                    className={`${TINT} text-[var(--oa-accent-fg)]`}
                  >
                    For most teams
                  </Badge>
                )}
              </div>
              <p className={`m-0 ${muted}`}>{WHO[c]}</p>
              <div>
                <p className="m-0">
                  <b className="text-[length:var(--oa-text-xl)]">{p.amount}</b>{" "}
                  <span className={muted}>{p.unit}</span>
                </p>
                {p.lines.map((l) => (
                  <p key={l} className={`m-0 ${muted}`}>
                    {l}
                  </p>
                ))}
              </div>
              {upgrade &&
                (current && !trial ? (
                  <Button variant="outline" disabled>
                    Current plan
                  </Button>
                ) : i > rank && c !== "solo" ? (
                  <Button
                    variant={c === "team" ? "default" : "outline"}
                    disabled={busy}
                    onClick={(e) => {
                      opener.current = e.currentTarget;
                      if (c === "business" && pendingReverts > 0) {
                        setThawAsk(true);
                        return;
                      }
                      start(c);
                    }}
                  >
                    Upgrade to {NAMES[c]}
                  </Button>
                ) : null)}
              <ul className="m-0 grid list-none gap-[var(--oa-space-1)] p-0 text-[length:var(--oa-text-sm)]">
                {POINTS[c].map((t) => (
                  <li key={t} className="flex gap-[var(--oa-space-2)]">
                    <span
                      aria-hidden="true"
                      className="text-[var(--oa-success)]"
                    >
                      ✓
                    </span>
                    {t}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {thawAsk && upgrade && (
        <Dialog open onOpenChange={(o) => !o && setThawAsk(false)}>
          <DialogContent
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              opener.current?.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>{THAW_COPY.confirmTitle}</DialogTitle>
              <DialogDescription>
                {THAW_COPY.confirmBody(pendingReverts)}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setThawAsk(false)}
              >
                {THAW_COPY.confirmNo}
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  setThawAsk(false);
                  start("business");
                }}
              >
                {THAW_COPY.confirmYes}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {asking && upgrade && (
        <SeatStep
          tier={asking}
          initial={seatsDefault ?? 1}
          busy={busy}
          onCancel={() => setAsking(null)}
          onClosed={() => opener.current?.focus()}
          onContinue={(seats) => upgrade(asking, seats)}
        />
      )}
      <ScrollFade>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <span className="sr-only">Feature</span>
              </TableHead>
              {ORDER.map((c) => (
                <TableHead
                  key={c}
                  aria-current={c === column ? "true" : undefined}
                  className={`text-center ${c === "team" ? TINT : ""}`}
                >
                  {NAMES[c]}
                  {c === column && (
                    <span className="sr-only"> (your plan)</span>
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {GROUPS.map((g) => (
              <Fragment key={g.title}>
                <TableRow>
                  <TableHead
                    scope="colgroup"
                    colSpan={4}
                    className="pt-[var(--oa-space-4)] text-[length:var(--oa-text-xs)] font-semibold text-muted-foreground"
                  >
                    {g.title}
                  </TableHead>
                </TableRow>
                {g.rows.map((r) => (
                  <TableRow key={r.row}>
                    <TableHead
                      scope="row"
                      className="font-normal whitespace-normal"
                    >
                      {r.row}
                    </TableHead>
                    {ORDER.map((c) => (
                      <TableCell
                        key={c}
                        className={`text-center ${c === "team" ? TINT : ""}`}
                      >
                        {r.on.includes(c) ? (
                          <>
                            <span
                              aria-hidden="true"
                              className="text-[var(--oa-success)]"
                            >
                              ✓
                            </span>
                            <span className="sr-only">Included</span>
                          </>
                        ) : (
                          <>
                            <span
                              aria-hidden="true"
                              className="text-muted-foreground"
                            >
                              —
                            </span>
                            <span className="sr-only">Not included</span>
                          </>
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </ScrollFade>
      <p className={`m-0 ${muted}`}>
        Team and Business bill per creator: people who publish or edit live data
        in a month. Viewers are free.
      </p>
    </section>
  );
}
