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
import { Maximize2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import {
  qk,
  useDeleteArtifact,
  usePatchArtifact,
  useVersionInfo,
} from "../api/queries";
import { accessLabel, useCan, useHosted } from "../auth/permissions";
import { Modal } from "../layout/Modal";
import { toast } from "../layout/toast";
import { VersionsDot } from "./LiveChip";
import { VERSIONS_PANEL_ID } from "./panels/Versions";
import { fullPath } from "./paths";
import { ICON, LINK_BTN, SM, TXT, VisibilityBadge } from "./ui";
import { useOfferUndo } from "./useOfferUndo";
import { versionDate } from "./versionDate";

const TITLE_MAX = 200;
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
}: {
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
  const navigate = useNavigate();
  const qc = useQueryClient();
  const del = useDeleteArtifact(artifact.id);
  const offerUndo = useOfferUndo();
  const [confirm, setConfirm] = useState(false);
  const can = useCan(artifact);
  const canShare = authed && (can.share || can.setVisibility);
  const canDelete = authed && can.delete;
  const canEdit = authed && can.edit;
  // Guests and contractors on live-data artifacts (D10); hosted only.
  const viewOnly =
    useHosted().features.includes("spaces") &&
    artifact.capabilities.db &&
    !can.dataWrite;
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
    <div className="oa-vt flex flex-wrap items-center gap-[10px] border-0 border-b border-border bg-card px-5 py-[10px] max-[600px]:px-4">
      <div className="flex min-w-0 items-center gap-2 max-[600px]:flex-[1_1_100%]">
        {iconFormat && <FormatIcon format={iconFormat} />}
        {canEdit ? (
          <EditableTitle artifact={artifact} />
        ) : (
          <h1 className={H1}>{artifact.title}</h1>
        )}
        <VisibilityBadge visibility={artifact.visibility} />
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
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 max-[600px]:flex-[1_1_100%]">
        {authed && (
          <ShButton
            variant="outline"
            size="xs"
            className={SM}
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
              <span className="-ml-1 whitespace-pre max-[600px]:hidden">{` · ${suffix}`}</span>
            )}
            {newer && !gone && <VersionsDot />}
          </ShButton>
        )}
        {live}
        {/* On phones it moves into the ••• menu, which only signed-in
            viewers have. */}
        {gone ? (
          <ShButton
            variant="outline"
            size="xs"
            className={`${SM} ${authed ? "max-[600px]:hidden" : ""}`}
            disabled
          >
            {MAXIMIZE}
            Full screen
          </ShButton>
        ) : (
          <ShButton
            asChild
            variant="outline"
            size="xs"
            className={`${LINK_BTN} ${authed ? "max-[600px]:hidden" : ""}`}
          >
            <a href={full} target="_blank" rel="noopener noreferrer">
              {MAXIMIZE}
              Full screen
            </a>
          </ShButton>
        )}
        {canShare && (
          <ShButton size="xs" className={SM} disabled={gone} onClick={onShare}>
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
                      className={SM}
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
            className={`${SM} text-primary-foreground hover:text-primary-foreground`}
          >
            <a href={`${AUTH.login}?next=${encodeURIComponent(next)}`}>
              Sign in
            </a>
          </ShButton>
        )}
      </div>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete artifact?"
        description={`"${artifact.title}" will be recoverable for 30 days.`}
        footer={
          <>
            <ShButton variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </ShButton>
            <ShButton
              variant="destructive"
              disabled={del.isPending}
              aria-busy={del.isPending}
              onClick={() => {
                if (deleting.current) return;
                deleting.current = true;
                del.mutate(undefined, {
                  onSuccess: () => {
                    deleted.current = true;
                    go("/");
                    offerUndo(artifact.id, artifact.title);
                  },
                  onError: () => {
                    deleting.current = false;
                    toast({ title: "Couldn't delete", tone: "danger" });
                  },
                });
              }}
            >
              Delete
            </ShButton>
          </>
        }
      />
    </div>
  );
}
