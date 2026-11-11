import type { ArtifactSummary } from "@oa/shared";
import {
  Button,
  ScrollArea,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@oa/ui/shadcn";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { TXT } from "../ui";
import { Details } from "./Details";
import { Share } from "./Share";
import { refocusPending, VERSIONS_PANEL_ID, Versions } from "./Versions";

export const PANEL_TABS = ["comments", "versions", "share", "details"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];
export const isPanelTab = (t: unknown): t is PanelTab =>
  PANEL_TABS.includes(t as PanelTab);

const LABELS: Record<PanelTab, string> = {
  versions: "Versions",
  share: "Share",
  details: "Details",
  comments: "Comments",
};

/** Focus moved in on open is programmatic, so :focus-visible may not match. */
const PROGRAMMATIC =
  "data-[focus=programmatic]:focus:outline-2 data-[focus=programmatic]:focus:-outline-offset-2 data-[focus=programmatic]:focus:outline-solid data-[focus=programmatic]:focus:outline-ring";

/** Whatever opened the panel; kept across a remount (row clicks change the route). */
let opener: HTMLElement | null = null;

export function SidePanel({
  artifact,
  version,
  authed = true,
  tab,
  onTab,
  onClose,
  comments,
}: {
  /** The Comments tab's body; without it the tab is not offered. */
  comments?: ReactNode;
  artifact: ArtifactSummary;
  /** The version the viewer shows. */
  version: number;
  /** Signed-out viewers get the Comments tab alone. */
  authed?: boolean;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const tabs = PANEL_TABS.filter((t) =>
    t === "comments" ? comments !== undefined : authed,
  );
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Focus moves to the active tab's search, else the active tab, on open (the
  // container itself shows no ring) and back to whatever opened the panel on
  // close; if that remounted, to the version chip.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on open only
  useEffect(() => {
    const was = document.activeElement as HTMLElement | null;
    if (was && was !== document.body && !was.closest("aside")) opener = was;
    // A row click remounts the panel; the rows (child effects run first) may
    // already have put focus back on the clicked row.
    const target =
      refocusPending(artifact.id) || ref.current?.contains(was)
        ? null
        : (ref.current?.querySelector<HTMLElement>(
            '[role="tabpanel"][data-state="active"] [data-autofocus]',
          ) ??
          ref.current?.querySelector<HTMLElement>(
            '[role="tab"][data-state="active"]',
          ) ??
          ref.current);
    if (target) {
      target.dataset.focus = "programmatic";
      target.addEventListener("blur", () => delete target.dataset.focus, {
        once: true,
      });
      target.focus();
    }
    return () => {
      // A remount (row click) unmounts first and finds focus inside the panel.
      queueMicrotask(() => {
        if (document.querySelector("aside[aria-label='Side panel']")) return;
        const to = opener?.isConnected
          ? opener
          : document.querySelector<HTMLElement>("[data-versions-chip]");
        to?.focus();
      });
    };
  }, []);
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      // Below 960px the panel covers the frame.
      className="relative flex w-[var(--oa-comments-w)] flex-none flex-col overflow-hidden border-0 border-l border-l-[var(--oa-border)] bg-card outline-none max-[959.98px]:absolute max-[959.98px]:inset-0 max-[959.98px]:z-10 max-[959.98px]:w-auto max-[959.98px]:border-l-0"
      aria-label="Side panel"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) onClose();
      }}
    >
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* Centred on the 34px tab row below the 16px top padding. */}
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-[17px] right-4 z-10"
              aria-label="Close panel"
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close panel</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Tabs
        value={tab}
        onValueChange={(t) => isPanelTab(t) && onTab(t)}
        className="min-h-0 flex-1 gap-0"
      >
        {/* The tabs end before the close button (mr-9) and scroll sideways
            when the panel is too narrow for all four, never running under it. */}
        <div className="px-4 pt-4">
          <div className="border-b border-border">
            <TabStrip tab={tab}>
              <TabsList
                variant="line"
                className="flex h-auto w-auto justify-start gap-0 overflow-x-auto border-0 p-0 [scrollbar-width:none]"
              >
                {tabs.map((t) => (
                  <TabsTrigger
                    key={t}
                    value={t}
                    className={`h-[34px] flex-none rounded-sm px-2 ${TXT} ${PROGRAMMATIC}`}
                  >
                    {LABELS[t]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </TabStrip>
          </div>
        </div>
        {/* Versions scrolls its list under a fixed search box; the others scroll whole. */}
        {authed && (
          <TabsContent value="versions" className="flex min-h-0 flex-col">
            <div
              id={VERSIONS_PANEL_ID}
              className="flex min-h-0 flex-1 flex-col"
            >
              <Versions artifact={artifact} version={version} />
            </div>
          </TabsContent>
        )}
        {comments !== undefined && (
          <TabsContent value="comments" className="min-h-0">
            <ScrollArea className="h-full [&>[data-slot=scroll-area-viewport]>div]:!block">
              {comments}
            </ScrollArea>
          </TabsContent>
        )}
        {(
          [
            ["share", <Share key="share" artifact={artifact} />],
            ["details", <Details key="details" artifact={artifact} />],
          ] as const
        )
          .filter(() => authed)
          .map(([t, body]) => (
            <TabsContent key={t} value={t} className="min-h-0">
              <ScrollArea className="h-full [&>[data-slot=scroll-area-viewport]>div]:!block">
                <div className="px-4 pt-2 pb-4">{body}</div>
              </ScrollArea>
            </TabsContent>
          ))}
      </Tabs>
    </aside>
  );
}

/**
 * The tab row's frame: room for the close button, a right-edge
 * fade while tabs are off screen, and the active tab scrolled into view. The
 * focus ring is drawn inset so the scroller never clips it.
 */
function TabStrip({ tab, children }: { tab: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>('[role="tablist"]');
    if (!el) return;
    const update = () =>
      setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    update();
    el.addEventListener("scroll", update, { passive: true });
    // Some test DOMs have no ResizeObserver: the fade then follows scrolls only.
    const ro =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, []);
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
    <div ref={box} className="relative mr-9">
      {children}
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
