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
import { useEffect, useRef } from "react";
import { TXT } from "../ui";
import { Details } from "./Details";
import { Share } from "./Share";
import { refocusPending, VERSIONS_PANEL_ID, Versions } from "./Versions";

export const PANEL_TABS = ["versions", "share", "details"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];
export const isPanelTab = (t: unknown): t is PanelTab =>
  PANEL_TABS.includes(t as PanelTab);

const LABELS: Record<PanelTab, string> = {
  versions: "Versions",
  share: "Share",
  details: "Details",
};

/** Focus moved in on open is programmatic, so :focus-visible may not match. */
const PROGRAMMATIC =
  "data-[focus=programmatic]:focus:outline-2 data-[focus=programmatic]:focus:outline-offset-2 data-[focus=programmatic]:focus:outline-solid data-[focus=programmatic]:focus:outline-ring";

/** Whatever opened the panel; kept across a remount (row clicks change the route). */
let opener: HTMLElement | null = null;

export function SidePanel({
  artifact,
  version,
  tab,
  onTab,
  onClose,
}: {
  artifact: ArtifactSummary;
  /** The version the viewer shows. */
  version: number;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
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
      className="relative flex w-[353px] flex-none flex-col overflow-hidden border-0 border-l border-l-[var(--oa-border)] bg-card outline-none max-[959.98px]:absolute max-[959.98px]:inset-0 max-[959.98px]:z-10 max-[959.98px]:w-auto max-[959.98px]:border-l-0"
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
        <div className="px-4 pt-4">
          <TabsList
            variant="line"
            className="h-auto w-full justify-start gap-1 border-0 border-b border-border p-0 pr-9"
          >
            {PANEL_TABS.map((t) => (
              <TabsTrigger
                key={t}
                value={t}
                className={`h-[34px] flex-none rounded-sm px-3 ${TXT} ${PROGRAMMATIC}`}
              >
                {LABELS[t]}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {/* Versions scrolls its list under a fixed search box; the others scroll whole. */}
        <TabsContent value="versions" className="flex min-h-0 flex-col">
          <div id={VERSIONS_PANEL_ID} className="flex min-h-0 flex-1 flex-col">
            <Versions artifact={artifact} version={version} />
          </div>
        </TabsContent>
        {(
          [
            ["share", <Share key="share" artifact={artifact} />],
            ["details", <Details key="details" artifact={artifact} />],
          ] as const
        ).map(([t, body]) => (
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
