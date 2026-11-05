import { Input } from "@oa/ui/shadcn";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useCurrentSpace } from "../spaces/useCurrentSpace";

export const SEARCH_DEBOUNCE_MS = 250;
const PHONE = "(max-width: 639px)";

/** Whether `query` matches, following changes. */
const useMedia = (query: string) => {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const sync = () => setOn(m.matches);
    sync();
    m.addEventListener("change", sync);
    return () => m.removeEventListener("change", sync);
  }, [query]);
  return on;
};

export function SearchBox() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onSearch = pathname === "/search";
  const urlQ = useRouterState({
    select: (s) =>
      s.location.pathname === "/search"
        ? (new URLSearchParams(s.location.searchStr).get("q") ?? "")
        : "",
  });
  // Inside a space the search is scoped to it (Design, 2026-10-22): a chip
  // "in <space>" at the field's start; removing it, or Backspace on an empty
  // field, searches everywhere. Results pages keep the chip.
  const { space } = useCurrentSpace();
  const [unscoped, setUnscoped] = useState<string | null>(null);
  const scope = space && unscoped !== space.id ? space : null;
  const scopeName = scope
    ? scope.kind === "personal"
      ? "Personal"
      : scope.name
    : null;
  // Below 640px the chip drops "in" and the placeholder is just "Search".
  const phone = useMedia(PHONE);
  const chip = useRef<HTMLSpanElement>(null);
  const [inset, setInset] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the chip's text changes
  useLayoutEffect(() => {
    setInset(chip.current ? chip.current.offsetWidth + 10 : 0);
  }, [scopeName, phone]);
  const [value, setValue] = useState(urlQ);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const input = useRef<HTMLInputElement>(null);
  // Don't clobber what's being typed when the URL syncs back.
  useEffect(() => {
    if (document.activeElement !== input.current) setValue(urlQ);
  }, [urlQ]);
  // A pending search must not hijack a later navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on route change only
  useEffect(() => () => clearTimeout(timer.current), [pathname]);
  const go = (search: object) =>
    void navigate({ to: "/search", search, replace: onSearch } as never);
  const withScope = (q: string) => (scope ? { q, space: scope.id } : { q });
  const unscope = () => {
    if (!scope) return;
    setUnscoped(scope.id);
    clearTimeout(timer.current);
    if (onSearch) go(value.trim() ? { q: value } : {});
    input.current?.focus();
  };
  return (
    <div className="relative flex h-[30px] min-w-0 flex-1 items-center">
      {scopeName && (
        <span
          ref={chip}
          data-scope-chip=""
          className="absolute left-[4px] z-10 inline-flex h-[22px] max-w-[45%] items-center gap-[2px] rounded-sm bg-[var(--oa-surface-2)] pr-[2px] pl-[6px] text-[length:var(--oa-text-xs)] text-muted-foreground"
        >
          <span className="truncate">
            {phone ? scopeName : `in ${scopeName}`}
          </span>
          <button
            type="button"
            aria-label="Search everywhere"
            className="grid size-[18px] flex-none place-items-center rounded-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            onClick={unscope}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              width="10"
              height="10"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </span>
      )}
      <Input
        ref={input}
        type="search"
        aria-label={scopeName ? `Search in ${scopeName}` : "Search artifacts"}
        placeholder={
          scopeName
            ? phone
              ? "Search"
              : `Search ${scopeName}`
            : "Search titles and content"
        }
        style={scopeName && inset ? { paddingLeft: inset } : undefined}
        className="h-[30px] min-w-0 flex-1 text-[length:var(--oa-text-sm)] md:text-[length:var(--oa-text-sm)]"
        value={value}
        onKeyDown={(e) => {
          if (e.key === "Backspace" && !value && scope) {
            e.preventDefault();
            unscope();
          }
        }}
        onChange={(e) => {
          const q = e.target.value;
          setValue(q);
          clearTimeout(timer.current);
          if (!q.trim()) {
            if (onSearch) go(scope ? { space: scope.id } : {});
            return;
          }
          timer.current = setTimeout(
            () => go(withScope(q)),
            SEARCH_DEBOUNCE_MS,
          );
        }}
      />
    </div>
  );
}
