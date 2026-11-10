// #2007, Design's pricing A (Settings version): a Monthly/Yearly toggle, three
// plan cards, then the grouped comparison table with Team tinted. The current
// plan's card says so; higher plans offer the existing upgrade; lower plans
// have no button. Yearly Team and Business prices are proposed until the user
// confirms them and Billing makes them, and the page says so.
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
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { muted } from "./ui";

export type Column = "solo" | "team" | "business";
type Interval = "month" | "year";

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
const PRICE: Record<
  Column,
  Record<Interval, { amount: string; unit: string; line: string }>
> = {
  solo: {
    month: { amount: "$1", unit: "a month", line: "Per instance" },
    year: { amount: "$10", unit: "a year", line: "2 months free" },
  },
  team: {
    month: {
      amount: "$10",
      unit: "per creator a month",
      line: "Billed monthly",
    },
    year: {
      amount: "$8",
      unit: "per creator a month",
      line: "$96 a year, billed yearly",
    },
  },
  business: {
    month: {
      amount: "$25",
      unit: "per creator a month",
      line: "Billed monthly",
    },
    year: {
      amount: "$20",
      unit: "per creator a month",
      line: "$240 a year, billed yearly",
    },
  },
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
    "Shared spaces and company sign-in",
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
      { row: "Company sign-in", on: ["team", "business"] },
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
}: {
  value: Interval;
  onChange: (v: Interval) => void;
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
        Save up to 20%
      </span>
    </div>
  );
}

export function PlanCompare({
  column,
  upgrade,
  busy,
  trial = false,
}: {
  /** The current plan's column (a Business trial is Business). */
  column: Column;
  /** Start the existing upgrade flow; absent: no buttons (can't buy here). */
  upgrade?: (tier: "team" | "business") => void;
  busy: boolean;
  /** A Business trial: nothing is paid yet, so both upgrades show and Business says "Your trial". */
  trial?: boolean;
}) {
  const [interval, setInterval] = useState<Interval>("year");
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
        <Toggle value={interval} onChange={setInterval} />
      </div>
      <div className="grid gap-[var(--oa-space-3)] md:grid-cols-3">
        {ORDER.map((c, i) => {
          const p = PRICE[c][interval];
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
              <div className="flex flex-wrap items-center gap-[var(--oa-space-2)]">
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
                <p className={`m-0 ${muted}`}>{p.line}</p>
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
                    onClick={() => upgrade(c)}
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
      {interval === "year" && (
        <p className={`m-0 ${muted}`}>
          Proposed, not decided: Team and Business at 20% off yearly ($8 and $20
          a creator a month). Solo&apos;s $10 a year is already decided.
        </p>
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
                    className="pt-[var(--oa-space-4)] text-[length:var(--oa-text-xs)] font-semibold tracking-wide text-muted-foreground uppercase"
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
