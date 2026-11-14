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
import { type ReactNode, useEffect, useRef } from "react";
import { TabStrip } from "../../layout/TabStrip";
import { useCommentsApi } from "../comments/useComments";
import { useWide } from "../comments/useWide";
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
  commentsCount,
}: {
  /** The Comments tab's body; without it the tab is not offered. */
  comments?: ReactNode;
  /** #2486: the open count, shown on the Comments tab (between phones and wide windows). */
  commentsCount?: number;
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
  const cmt = useCommentsApi();
  const tabs = PANEL_TABS.filter((t) =>
    t === "comments" ? comments !== undefined : authed,
  );
  // #2381: Decisions joins the row after Comments under 960px (wider, the comments body has its own tabs).
  const wide = useWide();
  const withDecisions = comments !== undefined && !wide;
  const shown =
    tab === "comments" && cmt.view === "decisions" ? "decisions" : tab;
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
      data-oa-keep-selection=""
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
            {/* Centred on the 34px tabs below the 11px top padding (the row adds 5px under them for the active line). */}
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-[12px] right-4 z-10"
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
        value={shown}
        onValueChange={(t) => {
          if (t === "decisions") {
            cmt.setView("decisions");
            onTab("comments");
          } else if (isPanelTab(t)) {
            if (t === "comments") cmt.setView("comments");
            onTab(t);
          }
        }}
        className="min-h-0 flex-1 gap-0"
      >
        {/* The tabs end before the close button (mr-9) and scroll sideways
            when the panel is too narrow for all four, never running under it. */}
        <div className="px-4 pt-[11px]">
          <div className="border-b border-border">
            <TabStrip tab={shown} count={tabs.length + (withDecisions ? 1 : 0)}>
              <TabsList
                variant="line"
                className="flex h-auto w-auto justify-start group-data-[orientation=horizontal]/tabs:h-auto gap-0 overflow-x-auto overflow-y-hidden border-0 p-0 pb-[5px] [scrollbar-width:none]"
              >
                {tabs.flatMap((t) => {
                  const trigger = (v: string) => (
                    <TabsTrigger
                      key={v}
                      value={v}
                      className={`h-[34px] flex-none rounded-sm px-2 focus-visible:-outline-offset-2 ${TXT} ${PROGRAMMATIC}`}
                      aria-label={
                        v === "comments" && commentsCount
                          ? `Comments, ${commentsCount} open`
                          : undefined
                      }
                    >
                      {v === "decisions" ? "Decisions" : LABELS[t]}
                      {/* A space: the visible "Comments 3" is inside the name "Comments, 3 open". */}
                      {v === "comments" && !!commentsCount && " "}
                      {v === "comments" && !!commentsCount && (
                        <span
                          data-tab-count=""
                          className="rounded-full bg-primary px-1.5 text-[length:var(--oa-text-xs)] text-primary-foreground"
                        >
                          {commentsCount}
                        </span>
                      )}
                      {v === "decisions" && !cmt.loading && (
                        <span
                          data-decisions-count=""
                          className="ml-1 font-normal text-muted-foreground"
                        >
                          {cmt.decisions.length}
                        </span>
                      )}
                    </TabsTrigger>
                  );
                  return t === "comments" && withDecisions
                    ? [trigger(t), trigger("decisions")]
                    : [trigger(t)];
                })}
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
        {comments !== undefined &&
          (["comments", "decisions"] as const).map((v) => (
            <TabsContent key={v} value={v} className="min-h-0">
              <ScrollArea className="h-full [&>[data-slot=scroll-area-viewport]>div]:!block">
                {comments}
              </ScrollArea>
            </TabsContent>
          ))}
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
