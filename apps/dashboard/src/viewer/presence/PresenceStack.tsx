import type { PresenceEntry } from "@oa/shared";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@oa/ui/shadcn";
import { useEffect, useState } from "react";
import { PresenceAvatar, presenceName } from "./PresenceAvatar";
import { PresenceCard, PresenceRow } from "./PresenceCard";

/** Faces shown before "+N" (3 then "+N"; all when there are 4 or fewer). */
const WIDE_ALL = 4;
const WIDE_SHOWN = 3;
/** On a phone: one face and "+N". */
const NARROW_SHOWN = 1;
const PHONE = "(max-width: 600px)";

function useNarrow() {
  const q = () =>
    typeof window.matchMedia === "function" && window.matchMedia(PHONE).matches;
  const [narrow, setNarrow] = useState(q);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const m = window.matchMedia(PHONE);
    const on = () => setNarrow(m.matches);
    on();
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return narrow;
}

function Face({ entry }: { entry: PresenceEntry }) {
  const name = presenceName(entry);
  return (
    <Popover>
      <Tooltip>
        <PopoverTrigger asChild>
          <TooltipTrigger asChild>
            <PresenceAvatar
              as="button"
              entry={entry}
              size={28}
              aria-label={name}
            />
          </TooltipTrigger>
        </PopoverTrigger>
        <TooltipContent side="bottom" collisionPadding={8}>
          {name}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        collisionPadding={8}
        className="w-[260px] p-3"
        aria-label={name}
      >
        <PresenceCard entry={entry} />
      </PopoverContent>
    </Popover>
  );
}

function More({
  rest,
  n,
  narrow,
}: {
  rest: PresenceEntry[];
  n: number;
  narrow: boolean;
}) {
  const [open, setOpen] = useState(false);
  const label = `${n} more here`;
  const chip = (props: { onClick?: () => void }) => (
    <button
      type="button"
      className="oa-pface oa-pmore"
      aria-label={label}
      style={{ width: 28, height: 28, borderRadius: "50%" }}
      {...props}
    >
      +{n}
    </button>
  );
  const list = (
    <div className="flex flex-col gap-px">
      {rest.map((e) => (
        <PresenceRow key={e.key} entry={e} />
      ))}
    </div>
  );
  if (narrow) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        {chip({ onClick: () => setOpen(true) })}
        <SheetContent side="bottom" className="max-h-[70vh] overflow-auto">
          <SheetHeader>
            <SheetTitle>{label}</SheetTitle>
            <SheetDescription className="sr-only">
              The other people and agents here now
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">{list}</div>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{chip({})}</PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={8}
        className="w-[268px] p-1.5"
        aria-label={label}
      >
        <div className="px-2 pb-1 pt-1.5 text-xs font-semibold text-muted-foreground">
          {label}
        </div>
        {list}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Who else is here (#949): 28px faces, 4px apart, no overlap, in the order given
 * (usePresence puts the oldest arrival first). `total` counts OTHERS (usePresence subtracts the caller), so
 * "+N" is `total` minus the faces shown, even when the list is capped.
 */
export function PresenceStack({
  others,
  total,
}: {
  others: PresenceEntry[];
  total: number;
}) {
  const narrow = useNarrow();
  const count = Math.max(total, others.length);
  if (count === 0 || others.length === 0) return null;
  const limit = narrow ? NARROW_SHOWN : WIDE_ALL;
  const all = count <= limit;
  const shown = all
    ? others
    : others.slice(0, narrow ? NARROW_SHOWN : WIDE_SHOWN);
  return (
    <TooltipProvider delayDuration={300}>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would add form semantics and default styles; the group role is the design */}
      <div
        role="group"
        aria-label={`${count} people here now`}
        className="oa-pstack inline-flex items-center gap-1"
      >
        {shown.map((e) => (
          <Face key={e.key} entry={e} />
        ))}
        {!all && (
          <More
            rest={others.slice(shown.length)}
            n={count - shown.length}
            narrow={narrow}
          />
        )}
      </div>
    </TooltipProvider>
  );
}
