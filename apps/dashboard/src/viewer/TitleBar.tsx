import { type ArtifactSummary, AUTH, R, viewerPath } from "@oa/shared";
import { FormatIcon } from "@oa/ui";
import {
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Button as ShButton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@oa/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Maximize2, MessageSquare, MessageSquarePlus } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ApiClientError } from "../api/client";
import {
  qk,
  useDeleteArtifact,
  usePatchArtifact,
  useVersionInfo,
} from "../api/queries";
import { accessLabel, useCan } from "../auth/permissions";
import { toast } from "../layout/toast";
import { ConfirmDialog } from "../settings/ConfirmDialog";
import { useNarrow } from "./comments/surfaces";
import { VersionsDot } from "./LiveChip";
import { VERSIONS_PANEL_ID } from "./panels/Versions";
import { fullPath } from "./paths";
import { BAR, ICON, TXT, VisibilityBadge } from "./ui";
import { useOfferUndo } from "./useOfferUndo";
import { versionDate } from "./versionDate";

const TITLE_MAX = 200;
/** #2503: the title keeps at least this many characters before anything else gives way. */
const TITLE_FLOOR = 10;
/** Between the phone layout and the wide one (#2486): the bar stays one row. */
const BETWEEN = "(min-width: 601px) and (max-width: 959.98px)";
const between = {
  subscribe: (cb: () => void) => {
    const m = window.matchMedia?.(BETWEEN);
    m?.addEventListener?.("change", cb);
    return () => m?.removeEventListener?.("change", cb);
  },
  get: () => window.matchMedia?.(BETWEEN).matches ?? false,
};
/** Stages the one-row bar gives way in (#2503): Comments to its icon, then the visibility chip, then the pill's "for you". */
export const BAR_STAGES = 3;

/**
 * #2503: the one-row bar (601px to 959px) gives way a step at a time while it
 * overflows or cuts the title below its floor (see shortfall). Each step notes the width the row needed at the
 * step before, and steps back only once the bar is that wide again, so no
 * width flips between two stages. A change of content starts again from 0;
 * every step runs in a layout effect, before paint, and stops at BAR_STAGES.
 */
/**
 * How much wider the bar would need to be: its own overflow, or how far the
 * title is cut below TITLE_FLOOR characters (the first TITLE_FLOOR characters
 * plus room for the ellipsis; a shorter title, its whole width).
 */
const shortfall = (el: HTMLElement) => {
  const over = el.scrollWidth - el.clientWidth;
  const h1 = el.querySelector("h1");
  const text = (h1?.querySelector("button") ?? h1) as HTMLElement | null;
  const node = text?.firstChild;
  let cut = 0;
  if (text && node?.nodeType === Node.TEXT_NODE) {
    const r = document.createRange();
    r.setStart(node, 0);
    r.setEnd(node, Math.min(TITLE_FLOOR, node.textContent?.length ?? 0));
    const em = Number.parseFloat(getComputedStyle(text).fontSize) || 16;
    const floor = Math.min(
      text.scrollWidth,
      r.getBoundingClientRect().width + 0.8 * em,
    );
    cut = Math.ceil(floor - text.clientWidth);
  }
  return Math.max(0, over, cut);
};

export function useBarStage(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  content: string,
) {
  const [stage, setStage] = useState(0);
  const [, tick] = useState(0);
  const need = useRef<number[]>([]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !active || typeof ResizeObserver === "undefined") return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== w) {
        w = el.clientWidth;
        setStage((s) => {
          let n = s;
          while (n > 0 && w >= (need.current[n] ?? Number.POSITIVE_INFINITY))
            n--;
          return n;
        });
      }
      // Either way a render re-checks the overflow below.
      tick((t) => t + 1);
    });
    ro.observe(el);
    // A group changing size (a late font, the live chip) re-checks too.
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => ro.disconnect();
  }, [ref, active]);
  const key = `${active}|${content}`;
  const was = useRef(key);
  // After every render: one step while the row overflows. New content (the
  // pill comes or goes, a count, the title) measures afresh from 0, in this
  // same effect so no step lands on top of the reset.
  useLayoutEffect(() => {
    const el = ref.current;
    if (was.current !== key) {
      was.current = key;
      need.current = [];
      if (stage !== 0) {
        setStage(0);
        return;
      }
    }
    if (!active || !el || stage >= BAR_STAGES) return;
    const over = shortfall(el);
    if (over > 0) {
      need.current[stage + 1] = el.clientWidth + over;
      setStage(stage + 1);
    }
  });
  return active ? stage : 0;
}
/** The page h1: Design's 20/600. */
const H1 =
  "min-w-0 truncate text-[length:var(--oa-text-xl)] leading-tight font-semibold";

function EditableTitle({ artifact }: { artifact: ArtifactSummary }) {
  const patch = usePatchArtifact(artifact.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const done = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  // Enter/Escape return focus to the title; a blur elsewhere keeps it there.
  const refocus = useRef(false);
  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false;
      button.current?.focus();
    }
  }, [editing]);

  const finish = (save: boolean, keyboard = false) => {
    if (done.current) return;
    done.current = true;
    refocus.current = keyboard;
    setEditing(false);
    const title = draft.trim().slice(0, TITLE_MAX);
    if (!save || !title || title === artifact.title) return;
    patch.mutate(
      { title },
      {
        onError: (e) =>
          toast({
            title: e instanceof ApiClientError ? e.message : "Couldn't rename",
            tone: "danger",
          }),
      },
    );
  };

  if (!editing)
    return (
      <h1 className={H1}>
        <button
          ref={button}
          type="button"
          className="max-w-full cursor-text truncate border-0 bg-transparent p-0 [font:inherit] underline-offset-[3px] hover:underline hover:decoration-dotted focus-visible:rounded-sm focus-visible:underline focus-visible:decoration-dotted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring"
          title="Rename"
          onClick={() => {
            done.current = false;
            setDraft(artifact.title);
            setEditing(true);
          }}
        >
          {artifact.title}
        </button>
      </h1>
    );
  return (
    <h1 className={H1}>
      <Input
        className="oa-vt-input h-8 w-[min(480px,60vw)] text-[length:var(--oa-text-lg)]"
        aria-label="Title"
        value={draft}
        maxLength={TITLE_MAX}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(true, true);
          else if (e.key === "Escape") finish(false, true);
        }}
      />
    </h1>
  );
}

/** Full screen's icon: lucide Maximize2 at 14px, 4px from the label. */
const MAXIMIZE = <Maximize2 className="size-3.5" aria-hidden="true" />;
/** #2486: between 601px and 959px Full screen is its icon; the label stays its name. */
const FS_LABEL = "min-[601px]:max-[959.98px]:sr-only";
/** #2486: the Comments button looks pressed while the panel shows the list (601px to 959px). */
const PRESSED =
  "min-[601px]:max-[959.98px]:aria-expanded:border-[var(--oa-border-strong)] min-[601px]:max-[959.98px]:aria-expanded:bg-[var(--oa-sunken)] min-[601px]:max-[959.98px]:aria-expanded:shadow-[inset_0_1px_2px_rgb(0_0_0/0.12)]";

export function TitleBar({
  artifact,
  version,
  explicitVersion,
  authed,
  onShare,
  versionsOpen,
  onVersions,
  live,
  newer = false,
  gone = false,
  comments,
  asks,
}: {
  /**
   * #1614: unanswered asks addressed to the viewer; absent when the page has no asks.
   * `inPanel` (#2486): the open panel shows the pill itself, so the bar doesn't.
   */
  asks?: { count: number; onClick: () => void; inPanel?: boolean };
  /** The Comments button (#682): the open count, and what it toggles. Absent when comments are off. */
  comments?: {
    open: number;
    expanded: boolean;
    onClick: () => void;
    /** #1732: text is selected; the button comments on it. */
    selecting?: boolean;
  };
  artifact: ArtifactSummary;
  version: number;
  explicitVersion: boolean;
  authed: boolean;
  onShare: () => void;
  /** The Versions panel is open (the chip's aria-expanded). */
  versionsOpen: boolean;
  /** The chip and ••• Versions: open the Versions panel, or close it. */
  onVersions: () => void;
  /** The live-version chip, right after the version chip. */
  live?: ReactNode;
  /** A newer version exists and isn't shown: a dot on the version chip. */
  newer?: boolean;
  /** Deleted or no access: Full screen, Versions and Share are disabled. */
  gone?: boolean;
}) {
  const narrow = useNarrow();
  const navigate = useNavigate();
  // #2503: the one-row bar gives way in steps before the title drops below ~10 characters.
  const bar = useRef<HTMLDivElement>(null);
  const inBetween = useSyncExternalStore(
    between.subscribe,
    between.get,
    () => false,
  );
  const pill = comments && asks && asks.count > 0 && !asks.inPanel;
  const stage = useBarStage(
    bar,
    inBetween,
    [
      artifact.title,
      artifact.visibility,
      pill ? asks.count : "",
      comments?.open,
      comments?.selecting,
      version,
      !!live,
      authed,
    ].join("|"),
  );
  const qc = useQueryClient();
  const del = useDeleteArtifact(artifact.id);
  const offerUndo = useOfferUndo();
  const [confirm, setConfirm] = useState(false);
  const can = useCan(artifact);
  const canShare = authed && (can.share || can.setVisibility);
  const canDelete = authed && can.delete;
  const canEdit = authed && can.edit;
  // Live data the caller can't change: guests and contractors (D10), and
  // viewers of an editors-only artifact on any install (review item 28).
  const viewOnly = artifact.capabilities.db && !can.dataWrite;
  const go = (to: string) => void navigate({ to: to as string });

  const info = useVersionInfo(artifact.id, version, authed).data;
  const entry = info?.entry;
  const iconFormat =
    info?.format ??
    (version === artifact.currentVersion ? artifact.format : undefined);
  const deleting = useRef(false);
  const deleted = useRef(false);
  // Dropped only once the viewer has unmounted, so nothing refetches the 404.
  useEffect(
    () => () => {
      if (deleted.current)
        qc.removeQueries({ queryKey: qk.artifact(artifact.id) });
    },
    [qc, artifact.id],
  );
  const next = viewerPath(artifact.id, explicitVersion ? version : undefined);
  const full = fullPath(artifact.id);
  const openFull = () => window.open(full, "_blank", "noopener");
  // "v24 · Current" following the latest; pinned, the rows' date ("v21 · Jan 22").
  const suffix =
    version === artifact.currentVersion
      ? "Current"
      : info
        ? versionDate(info.createdAt)
        : "";
  const label = `v${version}${suffix ? ` · ${suffix}` : ""}`;
  const items: (
    | "separator"
    | { label: string; danger?: boolean; onSelect: () => void }
  )[] = [
    {
      label: "Copy link",
      onSelect: () =>
        void navigator.clipboard
          ?.writeText(location.origin + viewerPath(artifact.id))
          .then(
            () => toast({ title: "Link copied", tone: "success" }),
            () => {},
          ),
    },
    {
      label: "Copy full-screen link",
      onSelect: () =>
        void navigator.clipboard?.writeText(location.origin + full).then(
          () => toast({ title: "Full-screen link copied", tone: "success" }),
          () => {},
        ),
    },
    ...(authed && entry
      ? [
          {
            label: "Download entry",
            onSelect: () => {
              const a = document.createElement("a");
              a.href = R.versionFile(artifact.id, version, entry);
              a.download = entry.split("/").pop() ?? entry;
              a.click();
            },
          },
        ]
      : []),
    ...(canDelete
      ? [
          "separator" as const,
          { label: "Delete", danger: true, onSelect: () => setConfirm(true) },
        ]
      : []),
  ];

  return (
    // #2486: between phones and wide windows the title and the buttons share one line; the title truncates.
    <div
      ref={bar}
      data-bar-stage={inBetween ? stage : undefined}
      className="oa-vt flex flex-wrap items-center gap-[10px] border-0 border-b border-border bg-card px-5 py-[10px] max-[600px]:px-4 min-[601px]:max-[959.98px]:flex-nowrap"
    >
      <div className="flex min-w-0 items-center gap-2 max-[600px]:flex-[1_1_100%]">
        {iconFormat && <FormatIcon format={iconFormat} />}
        {canEdit ? (
          <EditableTitle artifact={artifact} />
        ) : (
          <h1 className={H1}>{artifact.title}</h1>
        )}
        <VisibilityBadge
          visibility={artifact.visibility}
          iconOnly={stage >= 2}
        />
        {viewOnly && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="secondary"
                  tabIndex={0}
                  className="h-[18px] rounded-sm px-[6px] py-0 text-[length:var(--oa-text-xs)]"
                >
                  View only
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom" collisionPadding={8}>
                You can view this, but you can't change its data.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {artifact.space && (
          <span className="text-[length:var(--oa-text-sm)] text-muted-foreground">
            {accessLabel(artifact.access)}
          </span>
        )}
      </div>
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 max-[600px]:flex-[1_1_100%] min-[601px]:max-[959.98px]:flex-none min-[601px]:max-[959.98px]:flex-nowrap">
        {pill && (
          <ShButton
            variant="outline"
            size="xs"
            data-asks-for-you
            aria-label={`${asks.count} ask${asks.count === 1 ? "" : "s"} for you`}
            className={`${BAR} border-0 bg-[var(--oa-warning-soft)] font-semibold text-[var(--oa-warning)] shadow-[inset_0_0_0_1px_var(--oa-warning)] hover:bg-[var(--oa-warning-soft)] hover:text-[var(--oa-warning)]`}
            disabled={gone}
            onClick={asks.onClick}
          >
            {asks.count} ask{asks.count === 1 ? "" : "s"}
            {narrow || stage >= 3 ? "" : " for you"}
          </ShButton>
        )}
        {comments && asks?.count === 0 && (
          <span
            data-asks-none
            className={`${TXT} whitespace-nowrap text-muted-foreground`}
          >
            No asks for you
          </span>
        )}
        {comments && (
          <ShButton
            variant="outline"
            size="xs"
            className={
              comments.selecting
                ? `${BAR} border-[var(--oa-accent)] bg-[var(--oa-accent-soft)] text-[var(--oa-accent-fg)] hover:bg-[var(--oa-accent-soft)] hover:text-[var(--oa-accent-fg)]`
                : `${BAR} ${PRESSED}`
            }
            aria-label={
              comments.selecting
                ? narrow
                  ? "Comment"
                  : "Comment on selection"
                : comments.open > 0
                  ? `Comments, ${comments.open} open`
                  : "Comments"
            }
            aria-expanded={comments.selecting ? undefined : comments.expanded}
            disabled={gone}
            data-oa-keep-selection=""
            onClick={comments.onClick}
          >
            {/* A space in the text: the visible label must read "Comments 3", inside the name "Comments, 3 open". */}
            {comments.selecting ? (
              <MessageSquarePlus aria-hidden="true" className="size-3.5" />
            ) : (
              <MessageSquare aria-hidden="true" className="size-3.5" />
            )}
            {comments.selecting ? (
              narrow ? (
                "Comment"
              ) : (
                "Comment on selection"
              )
            ) : (
              // #2503: the first to give way in a tight bar: the icon and count alone; the name stays "Comments, 3 open".
              <span className={stage >= 1 ? "sr-only" : undefined}>
                Comments
              </span>
            )}{" "}
            {!comments.selecting && comments.open > 0 && (
              <span className="rounded-full bg-primary px-1.5 text-[length:var(--oa-text-xs)] text-primary-foreground">
                {comments.open}
              </span>
            )}
          </ShButton>
        )}
        {authed && (
          <ShButton
            variant="outline"
            size="xs"
            className={BAR}
            aria-label={`Version: ${label}`}
            aria-expanded={versionsOpen}
            aria-controls={versionsOpen ? VERSIONS_PANEL_ID : undefined}
            data-versions-chip
            disabled={gone}
            onClick={onVersions}
          >
            v{version}
            {/* Phones show the number alone. */}
            {suffix && (
              <span className="-ml-1 whitespace-pre max-[959.98px]:hidden">{` · ${suffix}`}</span>
            )}
            {newer && !gone && <VersionsDot />}
          </ShButton>
        )}
        {live}
        {/* On phones it moves into the ••• menu, which only logged-in
            viewers have. */}
        {gone ? (
          <ShButton
            variant="outline"
            size="xs"
            className={`${BAR} ${authed ? "max-[600px]:hidden" : ""}`}
            disabled
          >
            {MAXIMIZE}
            <span className={FS_LABEL}>Full screen</span>
          </ShButton>
        ) : (
          <ShButton
            asChild
            variant="outline"
            size="xs"
            className={`${BAR} text-foreground hover:text-accent-foreground ${authed ? "max-[600px]:hidden" : ""}`}
          >
            <a href={full} target="_blank" rel="noopener noreferrer">
              {MAXIMIZE}
              <span className={FS_LABEL}>Full screen</span>
            </a>
          </ShButton>
        )}
        {canShare && (
          <ShButton size="xs" className={BAR} disabled={gone} onClick={onShare}>
            Share
          </ShButton>
        )}
        {authed ? (
          <TooltipProvider>
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <ShButton
                      variant="outline"
                      size="xs"
                      className={BAR}
                      aria-label="More actions"
                    >
                      •••
                    </ShButton>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>More actions</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className={TXT}>
                <DropdownMenuItem
                  className="gap-1 min-[601px]:hidden"
                  disabled={gone}
                  onSelect={openFull}
                >
                  {MAXIMIZE}
                  Full screen
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="min-[601px]:hidden"
                  disabled={gone}
                  onSelect={onVersions}
                >
                  Versions
                </DropdownMenuItem>
                <DropdownMenuSeparator className="min-[601px]:hidden" />
                {items.map((it) =>
                  it === "separator" ? (
                    <DropdownMenuSeparator key="separator" />
                  ) : (
                    <DropdownMenuItem
                      key={it.label}
                      variant={it.danger ? "destructive" : "default"}
                      onSelect={it.onSelect}
                    >
                      {it.label}
                    </DropdownMenuItem>
                  ),
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </TooltipProvider>
        ) : (
          <ShButton
            asChild
            size="xs"
            className={`${BAR} text-primary-foreground hover:text-primary-foreground`}
          >
            <a href={`${AUTH.login}?next=${encodeURIComponent(next)}`}>
              Log in
            </a>
          </ShButton>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete artifact?"
        body={<p>"{artifact.title}" will be recoverable for 30 days.</p>}
        confirm="Delete"
        danger
        pending="Deleting…"
        busy={del.isPending}
        onConfirm={() => {
          if (deleting.current) return;
          deleting.current = true;
          del.mutate(undefined, {
            onSuccess: () => {
              deleted.current = true;
              go("/");
              offerUndo(artifact.id);
            },
            onError: () => {
              deleting.current = false;
              toast({ title: "Couldn't delete", tone: "danger" });
            },
          });
        }}
      />
    </div>
  );
}
