import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * The tab row's frame: room for the close button, a right-edge
 * fade on each edge with tabs off screen, and the active tab scrolled into view. The
 * focus ring is drawn inset so the scroller never clips it.
 */
export function TabStrip({
  tab,
  count,
  className = "mr-9",
  children,
}: {
  tab: string;
  /** How many tabs show: a change re-measures the fades. */
  count: number;
  /** Margin around the strip: the panel keeps room for its close button. */
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const [less, setLess] = useState(false);
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>('[role="tablist"]');
    // Re-measured per tab count: new tabs grow the list's content, not its box.
    if (!el || count === 0) return;
    const update = () => {
      setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
      setLess(el.scrollLeft > 1);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    // Some test DOMs have no ResizeObserver: the fade then follows scrolls only.
    const ro =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    // A tab's own width changes (a font swap) resize the tabs, not the list.
    for (const t of el.children) ro?.observe(t);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, [count]);
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>('[role="tablist"]');
    // Radix names each trigger "<base>-trigger-<value>".
    const on = el?.querySelector<HTMLElement>(
      `[role="tab"][id$="-trigger-${tab}"]`,
    );
    if (!el || !on) return;
    // Scroll the list itself, never the page.
    if (on.offsetLeft < el.scrollLeft) el.scrollLeft = on.offsetLeft;
    else if (on.offsetLeft + on.offsetWidth > el.scrollLeft + el.clientWidth)
      el.scrollLeft = on.offsetLeft + on.offsetWidth - el.clientWidth;
  }, [tab]);
  return (
    <div ref={box} className={`relative ${className}`}>
      {children}
      {less && (
        <div
          aria-hidden="true"
          data-testid="tabs-fade-start"
          className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-card to-transparent"
        />
      )}
      {more && (
        <div
          aria-hidden="true"
          data-testid="tabs-fade"
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-card to-transparent"
        />
      )}
    </div>
  );
}
