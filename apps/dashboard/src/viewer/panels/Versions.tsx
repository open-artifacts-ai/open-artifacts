import {
  type ArtifactSummary,
  diffPath,
  type VersionInfo,
  viewerPath,
} from "@oa/shared";
import { displayName } from "@oa/ui";
import { Input, Button as ShButton, Skeleton } from "@oa/ui/shadcn";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { ApiClientError } from "../../api/client";
import {
  useRestoreVersion,
  useVersionInfo,
  useVersionPages,
} from "../../api/queries";
import { useSingleFlight } from "../../api/useSingleFlight";
import { useCan } from "../../auth/permissions";
import { toast } from "../../layout/toast";
import { AppLink } from "../../library/AppLink";
import { useSentinel } from "../../library/useInfinite";
import { ConfirmDialog } from "../../settings/ConfirmDialog";
import { LINK_BTN, SM, TXT } from "../ui";
import { exactDate, versionDate } from "../versionDate";

/** The panel's id: the version chip's aria-controls. */
export const VERSIONS_PANEL_ID = "oa-versions-panel";

/**
 * The row to focus when the panel mounts again after a row click (the viewer
 * remounts between /a/:id and /a/:id/v/:v), so focus stays on the row.
 */
let refocus: { id: string; version: number } | null = null;
/** A row click is moving focus back to its row: the panel skips its own autofocus. */
export const refocusPending = (id: string) => refocus?.id === id;

const author = (x: VersionInfo) => x.agent?.name ?? displayName(x.createdBy);
/** "12" or "v12": a version number to jump to. */
const jumpTo = (q: string) => {
  const m = /^v?(\d+)$/i.exec(q.trim());
  return m ? Number(m[1]) : null;
};
const matches = (x: VersionInfo, q: string) => {
  const n = q.trim().toLowerCase();
  return (
    (x.message ?? "").toLowerCase().includes(n) ||
    author(x).toLowerCase().includes(n)
  );
};

/** Each match of the query, case-insensitively, as <mark>; the rest as text. */
function Marked({ text, q }: { text: string; q: string }) {
  const n = q.trim().toLowerCase();
  if (!n) return text;
  const out: React.ReactNode[] = [];
  let from = 0;
  for (
    let at = text.toLowerCase().indexOf(n);
    at >= 0;
    at = text.toLowerCase().indexOf(n, from)
  ) {
    out.push(text.slice(from, at));
    out.push(
      <mark
        key={at}
        className="rounded-[2px] bg-[var(--oa-warning-soft)] px-[1px] text-foreground"
      >
        {text.slice(at, at + n.length)}
      </mark>,
    );
    from = at + n.length;
  }
  out.push(text.slice(from));
  return out;
}

/** Row actions: 44px tall on phones. */
const ACTION = `${LINK_BTN} max-[600px]:h-11`;

export function Versions({
  artifact,
  version,
}: {
  artifact: ArtifactSummary;
  /** The version the viewer shows. */
  version: number;
}) {
  const { id, currentVersion } = artifact;
  const q = useVersionPages(id);
  const restore = useRestoreVersion(id);
  const once = useSingleFlight();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const [target, setTarget] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<number | null>(null);
  const canRestore = useCan(artifact).edit;
  const box = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const sentinel = useSentinel(q);

  // A version can shift across a page boundary: keep its first copy.
  const seen = new Set<number>();
  const items = (q.data?.pages.flat() ?? []).filter(
    (x) => !seen.has(x.version) && seen.add(x.version),
  );
  const oldest = items[items.length - 1]?.version ?? 0;
  const jump = jumpTo(query);
  const jumpLoaded = jump !== null && seen.has(jump);
  const far = useVersionInfo(
    id,
    jump ?? 0,
    jump !== null && !jumpLoaded && jump >= 1 && jump <= currentVersion,
  ).data;
  const searching = query.trim() !== "";
  const shown = !searching
    ? items
    : jump !== null
      ? jumpLoaded
        ? items.filter((x) => x.version === jump)
        : far
          ? [far]
          : []
      : items.filter((x) => matches(x, query));
  const older = q.hasNextPage ? Math.max(oldest - 1, 0) : 0;
  // Roving tabindex: the last focused row, else the viewed one, else the first.
  const focused = shown.some((x) => x.version === active)
    ? active
    : (shown.find((x) => x.version === version)?.version ?? shown[0]?.version);

  const rowAt = (v: number) =>
    listRef.current?.querySelector<HTMLElement>(`[data-version="${v}"]`);
  const move = (v: number) => {
    setActive(v);
    rowAt(v)?.focus();
  };
  const ready = !q.isPending;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once the rows render
  useEffect(() => {
    if (!ready) return;
    if (refocus?.id === id) {
      const v = refocus.version;
      refocus = null;
      move(v);
      return;
    }
    // The panel opened before the rows loaded and parked focus on the tab:
    // search is where it belongs.
    const parked = document.activeElement as HTMLElement | null;
    if (
      parked?.dataset.focus === "programmatic" &&
      parked.getAttribute("role") === "tab"
    )
      box.current?.focus();
  }, [ready, id]);

  const onRowKey = (e: KeyboardEvent, i: number) => {
    const to = {
      ArrowDown: shown[Math.min(i + 1, shown.length - 1)],
      ArrowUp: shown[Math.max(i - 1, 0)],
      Home: shown[0],
      End: shown[shown.length - 1],
    }[e.key];
    if (!to) return;
    e.preventDefault();
    move(to.version);
  };
  // The panel stays open (search carries panel and tab); Current follows the latest.
  const open = (v: number) => {
    refocus = { id, version: v };
    void navigate({
      to: viewerPath(id, v === currentVersion ? undefined : v) as string,
      search: search as never,
    });
  };

  if (q.isPending)
    return (
      <div aria-busy="true" className="mt-3 grid gap-3 px-4">
        <span className="sr-only">Loading versions…</span>
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-7 w-24" />
      </div>
    );
  if (q.error && !items.length)
    return (
      <p role="alert" className="px-4">
        Couldn't load versions.
      </p>
    );

  const counting = searching && jump === null;
  // No visible count when nothing matches (the empty note says it); screen readers still hear it.
  const counted = counting && shown.length > 0;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: "/" anywhere in the panel focuses search
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (e.key !== "/" || e.target === box.current) return;
        e.preventDefault();
        box.current?.focus();
      }}
    >
      <div className="relative px-4 pt-3 pb-2">
        <Input
          ref={box}
          type="search"
          data-autofocus
          aria-label="Search versions"
          placeholder="Search messages or v12"
          className={`${TXT} pr-8 max-[600px]:h-11`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              // Clears first; the next Escape reaches the panel and closes it.
              e.preventDefault();
              setQuery("");
            } else if (e.key === "ArrowDown" && shown.length) {
              e.preventDefault();
              move(shown[0].version);
            }
          }}
        />
        {!query && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-6 -translate-y-1/2 rounded-sm border border-border px-[5px] font-mono text-[11px] leading-4 text-muted-foreground max-[600px]:hidden"
          >
            /
          </span>
        )}
      </div>
      <p
        role="status"
        aria-live="polite"
        className={`${counted ? "px-4 pb-1.5" : "sr-only"} m-0 text-[length:var(--oa-text-xs)] text-muted-foreground`}
      >
        {counted
          ? `${shown.length} of ${currentVersion} match`
          : counting
            ? "No loaded matches"
            : ""}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {shown.length > 0 && (
          <ol
            ref={listRef}
            aria-label="Versions"
            className="m-0 flex list-none flex-col gap-px p-0"
          >
            {shown.map((x, i) => {
              const current = x.version === currentVersion;
              const viewed = x.version === version;
              const pinned = current && !searching;
              const when = versionDate(x.createdAt);
              const exact = exactDate(x.createdAt);
              const msg = x.message?.trim();
              return (
                <li
                  key={x.version}
                  className={`rounded-md ${pinned ? "sticky top-0 z-[1] bg-card" : ""}`}
                >
                  <div
                    className={`rounded-md ${viewed ? "bg-[var(--oa-accent-soft)] shadow-[inset_3px_0_0_var(--oa-accent)]" : ""}`}
                  >
                    <button
                      type="button"
                      data-version={x.version}
                      tabIndex={x.version === focused ? 0 : -1}
                      aria-current={viewed ? "true" : undefined}
                      className={`grid w-full cursor-pointer gap-px rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring max-[600px]:min-h-11 max-[600px]:py-2.5 ${viewed ? "" : "hover:bg-[var(--oa-sunken)]"}`}
                      onFocus={() => setActive(x.version)}
                      onKeyDown={(e) => onRowKey(e, i)}
                      onClick={() => open(x.version)}
                    >
                      {/* The name reads "v21, 1 day ago, October 22 at 3:10 PM, message,
                          author": each comma sits inside its part, so Chrome's
                          spaces between flex items land after it. */}
                      <span className="flex items-baseline gap-1.5">
                        <span className="font-mono text-[12.5px] font-semibold">
                          v{x.version}
                          <span className="sr-only">,</span>
                        </span>{" "}
                        {current && (
                          <>
                            <span className="rounded-full bg-[var(--oa-success-soft)] px-[7px] text-[11px] font-medium text-[var(--oa-success)]">
                              Current<span className="sr-only">,</span>
                            </span>{" "}
                          </>
                        )}
                        <span
                          className="ml-auto text-[length:var(--oa-text-xs)] whitespace-nowrap text-muted-foreground"
                          title={exact}
                        >
                          {when}
                          <span className="sr-only">{`, ${exact},`}</span>
                        </span>
                      </span>{" "}
                      <span
                        className={`line-clamp-2 ${TXT} ${msg ? "" : "text-muted-foreground italic"}`}
                      >
                        {msg ? (
                          <Marked text={msg} q={counting ? query : ""} />
                        ) : (
                          "No message"
                        )}
                        <span className="sr-only">,</span>
                      </span>{" "}
                      <span className="text-[length:var(--oa-text-xs)] text-muted-foreground">
                        <Marked text={author(x)} q={counting ? query : ""} />
                      </span>
                    </button>
                    {/* Viewing Current: nothing to do from its row. */}
                    {viewed && !current && (
                      <div className="flex flex-wrap gap-1.5 px-2.5 pb-2">
                        <ShButton
                          asChild
                          variant="outline"
                          size="xs"
                          className={ACTION}
                        >
                          <AppLink href={viewerPath(id, x.version)}>
                            View
                          </AppLink>
                        </ShButton>
                        <ShButton
                          asChild
                          variant="outline"
                          size="xs"
                          className={ACTION}
                        >
                          <AppLink
                            href={diffPath(id, x.version, currentVersion)}
                          >
                            Compare with current
                          </AppLink>
                        </ShButton>
                        {canRestore && (
                          <ShButton
                            variant="outline"
                            size="xs"
                            className={`${SM} max-[600px]:h-11`}
                            onClick={() => setTarget(x.version)}
                          >
                            Restore
                          </ShButton>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {jump !== null && !jumpLoaded && far && (
          <p className="m-0 px-2.5 py-1.5 text-[length:var(--oa-text-xs)] text-muted-foreground">
            Jumped to v{jump} (not loaded yet).
          </p>
        )}
        {counting && shown.length === 0 && (
          <p
            className={`m-0 px-3 pt-3 text-center ${TXT} text-muted-foreground`}
          >
            No loaded version mentions "{query.trim()}".
          </p>
        )}
        {counting && older > 0 && (
          <div className="flex justify-center py-2">
            <ShButton
              variant="ghost"
              size="xs"
              className={`${SM} text-[var(--oa-accent-fg)] max-[600px]:h-11`}
              disabled={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            >
              {`Search older versions (${older} more)`}
            </ShButton>
          </div>
        )}
        {!searching && q.hasNextPage && (
          <div
            ref={sentinel}
            aria-busy={q.isFetchingNextPage}
            className={`min-h-8 py-2 text-center ${TXT} text-muted-foreground`}
          >
            {q.isFetchingNextPage ? "Loading older…" : ""}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        title={`Restore v${target ?? ""}?`}
        body={
          <p>
            This publishes a new version with the contents of the selected one.
          </p>
        }
        confirm="Restore version"
        pending="Restoring…"
        busy={restore.isPending}
        onConfirm={() =>
          target !== null &&
          once((done) =>
            restore.mutate(target, {
              onSuccess: (r) => {
                setTarget(null);
                void navigate({
                  to: viewerPath(id, r.version) as string,
                  search: search as never,
                });
              },
              onError: (e) =>
                toast({
                  title:
                    e instanceof ApiClientError
                      ? e.message
                      : "Couldn't restore",
                  tone: "danger",
                }),
              onSettled: done,
            }),
          )
        }
      />
    </div>
  );
}
