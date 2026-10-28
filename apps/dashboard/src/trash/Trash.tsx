// Trash (review item 9, Design's option A): the caller's deleted artifacts
// and those in spaces they manage, newest first, each with its countdown to
// the purge and Restore. No permanent delete or Empty trash in M1.
import { viewerPath } from "@oa/shared";
import { FormatIcon } from "@oa/ui";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@oa/ui/shadcn";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { TrashItem } from "../api/contract";
import { useRestoreDeleted, useSpaces, useTrash } from "../api/queries";
import { useHosted } from "../auth/permissions";
import { useMe } from "../auth/useMe";
import { LoadError } from "../layout/LoadError";
import { toast } from "../layout/toast";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { TrashIcon } from "../library/icons";
import { BAR, Empty, H1, META, PAGE } from "../library/ui";
import { uniqueItems, useSentinel } from "../library/useInfinite";
import { svg } from "../viewer/SlowNotice";

/** RetryIcon, turning the other way. */
const RestoreIcon = svg("M3 3.5v3h3M3 6.5A5 5 0 1 1 2.6 10");
// Radix items can't hold "", so "All spaces" travels as a sentinel.
const ALL = "__all";
const DAY = 86_400_000;
/** The countdown turns to the warning color at this many days or fewer. */
const SOON = 7;

const midnight = (t: number) => new Date(t).setHours(0, 0, 0, 0);
/** Calendar days from today to `iso` (0 today, negative once past). */
const daysUntil = (iso: string, now: number) =>
  Math.round((midnight(Date.parse(iso)) - midnight(now)) / DAY);

const dayFmt = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
});
const exactFmt = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

const deletedLine = (iso: string, now: number) =>
  daysUntil(iso, now) === 0
    ? "Deleted today"
    : `Deleted ${dayFmt.format(Date.parse(iso))}`;

const countdown = (days: number) =>
  days <= 0
    ? "Deletes today"
    : days === 1
      ? "Deletes tomorrow"
      : `Deletes in ${days} days`;

const spaceLabel = (s: NonNullable<TrashItem["space"]>) =>
  s.personal ? "Personal" : s.name;

function Countdown({ purgeAt, now }: { purgeAt: string; now: number }) {
  const days = daysUntil(purgeAt, now);
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <time
            dateTime={purgeAt}
            className={
              days <= SOON ? "font-medium text-[var(--oa-warning)]" : undefined
            }
          >
            {countdown(days)}
          </time>
        </TooltipTrigger>
        <TooltipContent>
          Deleted for good {exactFmt.format(Date.parse(purgeAt))}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function Row({
  item: a,
  now,
  chip,
  busy,
  onRestore,
}: {
  item: TrashItem;
  now: number;
  /** Spaces are on: show which one it was in. */
  chip: boolean;
  busy: boolean;
  onRestore: () => void;
}) {
  return (
    <li className="flex items-center gap-[var(--oa-space-3)] px-[var(--oa-space-3)] py-[10px]">
      {/* Dimmed: a deleted artifact doesn't open, so nothing here is a link. */}
      <div className="relative grid h-8 w-11 flex-none place-items-center overflow-hidden rounded-sm bg-[var(--oa-sunken)] text-muted-foreground opacity-70 shadow-[inset_0_0_0_1px_var(--oa-divider)] max-[600px]:h-[26px] max-[600px]:w-[34px]">
        <FormatIcon format={a.format} decorative />
        {a.thumbnailUrl && (
          <img
            src={a.thumbnailUrl}
            alt=""
            loading="lazy"
            className="absolute inset-0 block size-full object-cover"
            onError={(e) => {
              e.currentTarget.hidden = true;
            }}
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="m-0 truncate text-[length:var(--oa-text-sm)] font-medium text-[var(--oa-text-2)]">
          {a.title}
        </p>
        <div
          className={`mt-[2px] flex flex-wrap items-center gap-x-[var(--oa-space-2)] gap-y-[var(--oa-space-1)] ${META}`}
        >
          {chip && a.space && (
            <span className="inline-flex max-w-[160px] items-center truncate rounded-sm bg-[var(--oa-surface-2)] px-[6px] py-[1px]">
              {spaceLabel(a.space)}
            </span>
          )}
          {/* Phones drop the deleted date; the countdown is what matters. */}
          <time dateTime={a.deletedAt} className="max-[600px]:hidden">
            {deletedLine(a.deletedAt, now)}
          </time>
          <span aria-hidden="true" className="max-[600px]:hidden">
            ·
          </span>
          <Countdown purgeAt={a.purgeAt} now={now} />
        </div>
      </div>
      {/* Icon only on phones; the name says which artifact. */}
      <Button
        variant="outline"
        size="sm"
        className="flex-none text-[length:var(--oa-text-sm)] max-[600px]:px-[7px]"
        aria-label={`Restore ${a.title}`}
        disabled={busy}
        onClick={onRestore}
      >
        {RestoreIcon}
        <span className="max-[600px]:hidden">Restore</span>
      </Button>
    </li>
  );
}

export function Trash() {
  useDocumentTitle("Trash");
  const navigate = useNavigate();
  const { spaceId } = useSearch({ strict: false }) as { spaceId?: string };
  const { spaces, personalSpaceId, features } = useHosted();
  // Self-hosted (spaces off): one trash, no filter and no space chips.
  const spacesOn = features.includes("spaces");
  const q = useTrash(spacesOn ? spaceId : undefined);
  const restore = useRestoreDeleted();
  // Ids being restored: several can be in flight, each with its own toast.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const mark = (id: string, on: boolean) =>
    setBusy((b) => {
      const n = new Set(b);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const items = uniqueItems(q.data?.pages);
  const sentinel = useSentinel(q);
  const now = Date.now();
  // The spaces whose trash the caller sees: Personal, those they manage, and
  // for an uncapped org owner or admin every shared space (#792).
  const me = useMe();
  const admin =
    me.status === "authed" &&
    (me.me.user.role === "owner" || me.me.user.role === "admin") &&
    !me.me.auth?.cap;
  const every = useSpaces({ kind: "shared" }, spacesOn && admin);
  // Every shared space, not only the first page (a failed page stops here).
  useEffect(() => {
    if (every.hasNextPage && !every.isFetching && !every.isError)
      void every.fetchNextPage();
  }, [every]);
  const byId = new Map<string, string>();
  for (const s of spaces)
    if (s.kind === "shared" && s.myRole === "manager") byId.set(s.id, s.name);
  for (const s of every.data?.pages.flatMap((p) => p.items) ?? [])
    byId.set(s.id, s.name);
  const managed = [...byId]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const options = [
    { value: ALL, label: "All spaces" },
    ...(personalSpaceId ? [{ value: personalSpaceId, label: "Personal" }] : []),
    ...managed.map((s) => ({ value: s.id, label: s.name })),
  ];
  // A spaceId from a link that isn't listed still reads as itself.
  if (spaceId && !options.some((o) => o.value === spaceId))
    options.push({ value: spaceId, label: "This space" });

  const onRestore = (item: TrashItem) => {
    mark(item.id, true);
    restore.mutateAsync(item).then(
      (a) => {
        mark(item.id, false);
        // Its space may be gone: then the server puts it back in Personal.
        const to = !spacesOn
          ? null
          : a.space
            ? a.space.kind === "personal"
              ? "Personal"
              : a.space.name
            : item.space && spaceLabel(item.space);
        toast({
          title: to ? `Restored to ${to}.` : "Restored.",
          tone: "success",
          action: {
            label: "Open",
            onClick: () => void navigate({ to: viewerPath(a.id) as string }),
          },
        });
      },
      () => {
        mark(item.id, false);
        toast({
          title: `Couldn't restore "${item.title}". Try again.`,
          tone: "danger",
        });
      },
    );
  };

  return (
    <section className={PAGE}>
      <div className="min-w-0">
        <h1 className={H1}>Trash</h1>
        <p className="mt-[2px] mb-0 text-[length:var(--oa-text-sm)] text-muted-foreground">
          {spacesOn
            ? "Your deleted artifacts, and those in spaces you manage. Each is deleted for good 30 days after it was deleted."
            : "Your deleted artifacts. Each is deleted for good 30 days after it was deleted."}
        </p>
      </div>
      {spacesOn && (
        <div className={BAR}>
          <Select
            value={spaceId ?? ALL}
            onValueChange={(v) =>
              void navigate({
                to: "/trash",
                search: v === ALL ? {} : { spaceId: v },
              } as never)
            }
          >
            <SelectTrigger
              aria-label="Space"
              size="sm"
              className="min-w-[140px] text-[length:var(--oa-text-sm)]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {options.map((o) => (
                <SelectItem
                  key={o.value}
                  value={o.value}
                  className="text-[length:var(--oa-text-sm)]"
                >
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {q.isError && (
        <LoadError
          title="Couldn't load Trash."
          error={q.error}
          onRetry={() => void q.refetch()}
        />
      )}
      {q.isPending && (
        <div
          className="flex flex-col gap-[var(--oa-space-2)]"
          role="status"
          aria-busy="true"
          aria-label="Loading Trash"
        >
          {Array.from({ length: 4 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <Skeleton key={i} className="h-[52px]" />
          ))}
        </div>
      )}
      {q.isSuccess && items.length === 0 && (
        <Empty
          icon={<TrashIcon />}
          title="Trash is empty"
          description="Artifacts deleted by you or any AI agent stay here for 30 days. Restore one to put it back where it was."
        />
      )}
      {items.length > 0 && (
        <ul
          aria-label="Deleted artifacts"
          className="m-0 list-none divide-y divide-[var(--oa-divider)] overflow-hidden rounded-md bg-card p-0 text-card-foreground shadow-[var(--oa-shadow-1)]"
        >
          {items.map((a) => (
            <Row
              key={a.id}
              item={a}
              now={now}
              chip={spacesOn}
              busy={busy.has(a.id)}
              onRestore={() => onRestore(a)}
            />
          ))}
        </ul>
      )}
      <div ref={sentinel} className="h-px" />
    </section>
  );
}
