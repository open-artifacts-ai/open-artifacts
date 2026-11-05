// A Google group search box (ARIA 1.2 combobox with a listbox popup): it
// searches R.directoryGroups from 2 characters and hands the picked group to
// `onPick`. Shared by Directory (restricted groups) and the space mappings.
import { Button, Input } from "@oa/ui/shadcn";
import { useId, useState } from "react";
import type { DirectoryGroup } from "../api/contract";
import { useDirectoryGroups } from "../api/queries";
import { errorText, muted } from "./ui";

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

export function GroupPicker({
  label,
  placeholder,
  exclude = [],
  disabled,
  onPick,
}: {
  /** The accessible name, e.g. "Add a restricted group". */
  label: string;
  placeholder?: string;
  /** Group ids already chosen: never offered. */
  exclude?: string[];
  disabled?: boolean;
  onPick: (group: DirectoryGroup) => void;
}) {
  const id = useId();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const search = useDirectoryGroups(q);
  const options = (search.data?.pages.flatMap((p) => p.items) ?? []).filter(
    (g) => !exclude.includes(g.groupId),
  );
  const shown = open && q.trim().length >= 2;
  const optionId = (i: number) => `${id}-opt-${i}`;

  const pick = (g: DirectoryGroup) => {
    onPick(g);
    setQ("");
    setOpen(false);
    setActive(-1);
  };

  return (
    <div className="relative min-w-0">
      <Input
        role="combobox"
        aria-label={label}
        aria-expanded={shown}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={
          shown && active >= 0 && options[active] ? optionId(active) : undefined
        }
        placeholder={placeholder}
        value={q}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            if (!options.length) return;
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((i) => (i + step + options.length) % options.length);
          } else if (e.key === "Enter" && shown && options[active]) {
            e.preventDefault();
            pick(options[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
            setActive(-1);
          }
        }}
      />
      {shown && (
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
          className="absolute inset-x-0 top-[calc(100%+4px)] z-20 max-h-[240px] overflow-y-auto rounded-md border border-border bg-popover p-[var(--oa-space-1)] shadow-md"
        >
          {options.map((g, i) => (
            // Keyboard lives on the combobox (aria-activedescendant); options take the pointer only.
            // biome-ignore lint/a11y/useKeyWithClickEvents: see above
            <div
              key={g.groupId}
              id={optionId(i)}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              className="flex cursor-pointer items-baseline justify-between gap-[var(--oa-space-3)] rounded-sm px-[var(--oa-space-2)] py-[6px] text-[length:var(--oa-text-sm)] aria-selected:bg-accent hover:bg-accent"
              // mousedown, not click: the input's blur would close the list first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(g)}
            >
              <span className="min-w-0 truncate">{g.email}</span>
              <span className={`flex-none ${muted}`}>
                {g.name}
                {g.memberCount !== null && ` · ${people(g.memberCount)}`}
              </span>
            </div>
          ))}
          {!options.length && search.isError && !search.isFetching && (
            <div
              role="alert"
              className={`flex items-center justify-between gap-[var(--oa-space-2)] px-[var(--oa-space-2)] py-[6px] ${errorText}`}
            >
              <span>Couldn't search groups.</span>
              <Button
                size="sm"
                variant="outline"
                // mousedown, not click: the input's blur would close the list first.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void search.refetch()}
              >
                Retry
              </Button>
            </div>
          )}
          {!options.length && !(search.isError && !search.isFetching) && (
            <div
              role="presentation"
              className={`px-[var(--oa-space-2)] py-[6px] ${muted}`}
            >
              {search.isFetching ? "Searching…" : "No matching groups."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
