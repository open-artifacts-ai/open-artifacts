// #2287: the top bar names a hosted plan: "Solo trial · N days left" in a
// trial, then the plain name. Information, not a warning: the neutral chip
// style. The Solo trial's chip opens a short note on what happens at its end. Only owners and
// admins are told the trial's end (the server sends it to them alone).
import type { Me } from "@oa/shared";
import { Popover, PopoverContent, PopoverTrigger } from "@oa/ui/shadcn";
import { useState } from "react";

const DAY_MS = 86_400_000;
export const SOLO_TRIAL_DAYS = 30;

export type ChipPlan = {
  /** "Solo" or "Team". */
  name: "Solo" | "Team";
  /** Calendar days (local time) to the trial's end date; 0 on its last day; null when no trial runs. */
  daysLeft: number | null;
  /** The Solo trial with no card on file: the one with a note to open. */
  note: boolean;
};

const startOfDay = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** Calendar days from today to the day `end` falls on, in local time. */
export const calendarDaysTo = (end: number, now = Date.now()) =>
  Math.round((startOfDay(end) - startOfDay(now)) / DAY_MS);

/**
 * What the top bar says about a hosted Solo or Team plan (Product's wording):
 * "Solo trial · N days left" while a trial runs, then the plain plan name.
 * Nothing on a self-hosted instance or another tier. The trial's end reaches
 * owners and admins only; everyone else sees the plain name.
 */
export function chipPlan(
  me: Me | null | undefined,
  now = Date.now(),
): ChipPlan | null {
  const b = me?.instance.billing;
  if (!me?.instance.hosted || !b) return null;
  const ends = (iso: string | null | undefined) => {
    const t = iso ? Date.parse(iso) : Number.NaN;
    return t > now ? calendarDaysTo(t, now) : null;
  };
  if (b.tier === "solo") {
    const daysLeft = ends(b.soloTrialEndsAt);
    return {
      name: "Solo",
      daysLeft,
      note: daysLeft !== null && !b.soloCheckedOut,
    };
  }
  if (b.tier === "trial")
    return { name: "Team", daysLeft: ends(b.trialEndsAt), note: false };
  if (b.tier === "team") return { name: "Team", daysLeft: null, note: false };
  return null;
}

export const chipLabel = (p: ChipPlan) =>
  p.daysLeft === null
    ? p.name
    : `${p.name} trial \u00b7 ${
        p.daysLeft === 0
          ? "ends today"
          : `${p.daysLeft} ${p.daysLeft === 1 ? "day" : "days"} left`
      }`;

const CHIP =
  "inline-flex h-7 flex-none items-center whitespace-nowrap rounded-[var(--oa-radius-md)] border border-solid border-[var(--oa-divider)] bg-[var(--oa-surface)] px-2 font-[inherit] text-[length:var(--oa-text-xs)] text-[var(--oa-text-2)]";

export function PlanChip({ me }: { me: Me | null | undefined }) {
  const [open, setOpen] = useState(false);
  const plan = chipPlan(me);
  if (!plan) return null;
  const label = chipLabel(plan);
  // Only the Solo trial has a note; the rest is a plain label.
  if (!plan.note)
    return (
      <span data-testid="plan-chip" className={CHIP}>
        {label}
      </span>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="plan-chip"
          aria-haspopup="dialog"
          className={`${CHIP} cursor-pointer outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--oa-focus)] aria-expanded:border-[var(--oa-border-strong)]`}
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(300px,calc(100vw-24px))] text-[length:var(--oa-text-sm)]"
      >
        <div className="grid gap-[var(--oa-space-2)]">
          <h3 className="m-0 text-[14px] font-semibold">Your free month</h3>
          <p className="m-0 text-[var(--oa-text-2)]">
            No card needed. When the {SOLO_TRIAL_DAYS} days end, Solo is $1 a
            month or $10 a year.
          </p>
          <p className="m-0 text-[var(--oa-text-2)]">
            We email you 7 days before it ends and on the last day. If you do
            nothing, your artifacts become view-only. Nothing is deleted.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
