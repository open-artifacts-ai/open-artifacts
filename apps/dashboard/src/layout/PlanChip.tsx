// #2287: a hosted Solo instance in its free trial shows "Solo · 30 days free"
// in the top bar. It is information, not a warning: the neutral chip style. It
// opens a short note on what happens when the trial ends. Only owners and
// admins are told the trial's end (the server sends it to them alone).
import type { Me } from "@oa/shared";
import { Popover, PopoverContent, PopoverTrigger } from "@oa/ui/shadcn";
import { useState } from "react";

const DAY_MS = 86_400_000;
export const SOLO_TRIAL_DAYS = 30;

/** Whole days left in a running Solo trial (1..30), or null when none is running. */
export function soloTrialDaysLeft(
  me: Me | null | undefined,
  now = Date.now(),
): number | null {
  const b = me?.instance.billing;
  if (!me?.instance.hosted || b?.tier !== "solo" || !b.soloTrialEndsAt)
    return null;
  // A card on file means the "no card" note no longer holds: no chip.
  if (b.soloCheckedOut) return null;
  const left = Date.parse(b.soloTrialEndsAt) - now;
  if (!(left > 0)) return null;
  return Math.min(SOLO_TRIAL_DAYS, Math.ceil(left / DAY_MS));
}

export function PlanChip({ me }: { me: Me | null | undefined }) {
  const [open, setOpen] = useState(false);
  const days = soloTrialDaysLeft(me);
  if (days === null) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="plan-chip"
          aria-haspopup="dialog"
          className="inline-flex h-7 flex-none cursor-pointer items-center whitespace-nowrap rounded-[var(--oa-radius-md)] border border-solid border-[var(--oa-divider)] bg-[var(--oa-surface)] px-2 font-[inherit] text-[length:var(--oa-text-xs)] text-[var(--oa-text-2)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--oa-focus)] aria-expanded:border-[var(--oa-border-strong)]"
        >
          Solo · {days} {days === 1 ? "day" : "days"} free
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
