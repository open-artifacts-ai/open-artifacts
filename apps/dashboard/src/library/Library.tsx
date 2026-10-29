import type { Format } from "@oa/shared";
import {
  Button,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@oa/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import { qk } from "../api/queries";
import { useHosted } from "../auth/permissions";
import { useMe } from "../auth/useMe";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { AgentSetupBody, useCanSetUpAgent } from "../settings/AgentSetupCard";
import { copyText } from "../settings/ui";
import { sharedSpaceName } from "../spaces/label";
import { useUploadSpace } from "../spaces/SpacePicker";
import { useCurrentSpace } from "../spaces/useCurrentSpace";
import { DropZone } from "../upload/DropZone";
import { KINDS_LINE } from "../upload/openable";
import { AppLink } from "./AppLink";
import { ArtifactCard } from "./ArtifactCard";
import { ArtifactRow } from "./ArtifactRow";
import { Filters } from "./Filters";
import { LibraryIcon } from "./icons";
import { ALERT, BAR, Empty, GRID, H1, LIST, PAGE } from "./ui";
import { uniqueItems, useSentinel } from "./useInfinite";
import { type Scope, useLibraryQuery } from "./useLibraryQuery";

const PATH: Record<Scope, string> = {
  all: "/",
  mine: "/mine",
  shared: "/shared",
  team: "/team",
};
const TABS: { id: Scope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "mine", label: "Mine" },
  { id: "shared", label: "Shared with me" },
  { id: "team", label: "Team" },
];
const ROLE_LINE = {
  viewer: "You're a viewer",
  editor: "You're an editor",
  manager: "You're a manager",
} as const;
const VIEW_KEY = "oa.library.view";
type View = "grid" | "list";

const storedView = (): View | undefined => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "grid" || v === "list" ? v : undefined;
  } catch {
    return undefined;
  }
};
const storeView = (v: View) => {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {}
};

const EMPTY: Record<Scope, [string, React.ReactNode]> = {
  all: [
    "No artifacts yet",
    "Artifacts appear here when a connected agent publishes one.",
  ],
  mine: [
    "Ask your agent to publish something",
    <>
      Artifacts you publish show up here.{" "}
      <AppLink href="/settings/agents" className="underline underline-offset-2">
        Connect an agent in Settings → Agents
      </AppLink>
      .
    </>,
  ],
  shared: [
    "Nothing shared with you yet",
    "Artifacts others share with you appear here.",
  ],
  team: [
    "No team artifacts yet",
    "Artifacts shared with the whole team appear here.",
  ],
};

export function Library({ scope }: { scope: Scope }) {
  const me = useMe();
  const { space } = useCurrentSpace();
  const { spaces } = useHosted();
  const personal = space?.kind === "personal";
  const spaceName = space
    ? personal
      ? "Personal"
      : sharedSpaceName(space.name)
    : null;
  const myRole = space
    ? (spaces.find((x) => x.id === space.id)?.myRole ?? null)
    : null;
  useDocumentTitle(
    spaceName ??
      (scope === "all"
        ? "Library"
        : (TABS.find((t) => t.id === scope)?.label ?? null)),
  );
  const navigate = useNavigate();
  const s = useSearch({ strict: false }) as {
    format?: Format;
    agent?: string;
    space?: string;
    view?: View;
  };
  const view: View = s.view ?? storedView() ?? "grid";
  const go = (to: string, search: object) =>
    void navigate({ to, search } as never);
  const set = (patch: object) => go(PATH[scope], { ...s, ...patch });

  const q = useLibraryQuery({
    scope,
    format: s.format,
    agent: s.agent,
    space: space?.id,
  });
  // A space-scoped 404: the caller's role in it is gone (or the space is), and
  // /me is stale. Refetch /me so it leaves the sidebar; the notice outlives the
  // param it clears, until Back to Library.
  const qc = useQueryClient();
  const [revoked, setRevoked] = useState<{ id: string; name: string } | null>(
    null,
  );
  const gone =
    space !== null &&
    q.error instanceof ApiClientError &&
    q.error.status === 404;
  const spaceId = space?.id;
  const spaceNameNow = space?.name ?? "";
  useEffect(() => {
    if (!gone || !spaceId) return;
    setRevoked((r) =>
      r?.id === spaceId ? r : { id: spaceId, name: spaceNameNow },
    );
  }, [gone, spaceId, spaceNameNow]);
  // One /me refetch per revoked space, not one per re-render of it.
  const refetchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!revoked || refetchedFor.current === revoked.id) return;
    refetchedFor.current = revoked.id;
    void qc.invalidateQueries({ queryKey: qk.me });
  }, [revoked, qc]);
  useEffect(() => {
    if (spaceId && revoked && spaceId !== revoked.id) setRevoked(null);
  }, [spaceId, revoked]);
  const showRevoked = gone || revoked !== null;
  const items = uniqueItems(q.data?.pages);
  // Remember agents seen so far so others stay selectable while one is filtered.
  const seenAgents = useRef(new Set<string>());
  for (const a of items)
    if (a.lastAgent) seenAgents.current.add(a.lastAgent.name);
  const agents = [...seenAgents.current].sort();
  const guest = me.status === "authed" && me.me.user.role === "guest";
  const meId = me.status === "authed" ? me.me.user.id : undefined;
  // Guests and restricted (capped) members can't create anywhere.
  const canCreate =
    me.status === "authed" && !guest && (me.me.auth?.cap ?? null) === null;

  const canSetUpAgent = useCanSetUpAgent();
  const sentinel = useSentinel(q);

  const filtered = Boolean(s.format || s.agent);
  const canPublishHere =
    personal || myRole === "editor" || myRole === "manager";
  const uploadSpace = useUploadSpace(space?.id);
  const [emptyTitle, emptyText] =
    space && scope === "all"
      ? personal
        ? [
            "Your personal space",
            "Only you can see what's here until you share it or move it to a space.",
          ]
        : canPublishHere
          ? [
              `Nothing in ${space.name} yet`,
              `Ask any AI agent to publish here, for example "publish this to ${space.name}".`,
            ]
          : [
              `Nothing in ${space.name} yet`,
              "You can view this space. What its editors publish shows up here.",
            ]
      : EMPTY[scope];
  const emptyAction =
    scope === "mine" && !space ? (
      canSetUpAgent ? (
        <div className="w-full max-w-[420px]">
          <AgentSetupBody />
        </div>
      ) : undefined
    ) : space && scope === "all" && !personal && canPublishHere ? (
      <Button
        size="sm"
        variant="outline"
        className="text-[length:var(--oa-text-sm)]"
        onClick={() =>
          copyText(`publish this to ${space.name}`, "Prompt copied")
        }
      >
        Copy prompt
      </Button>
    ) : undefined;

  const results = (
    <>
      <Filters
        format={s.format}
        agent={s.agent}
        agents={agents}
        view={view}
        onFormat={(format) => set({ format })}
        onAgent={(agent) => set({ agent })}
        onClear={() => set({ format: undefined, agent: undefined })}
        onView={(v) => {
          storeView(v);
          set({ view: v });
        }}
      />
      {q.isError && !showRevoked && (
        <div className={ALERT} role="alert">
          <span className="flex-1">
            <strong>Couldn't load the library.</strong> Your artifacts are safe;
            this is usually brief.
          </span>
          <Button
            size="sm"
            variant="outline"
            className="text-[length:var(--oa-text-sm)]"
            onClick={() => void q.refetch()}
          >
            Retry
          </Button>
        </div>
      )}
      {q.isPending && !q.isError && (
        <div
          className={view === "grid" ? GRID : LIST}
          role="status"
          aria-busy="true"
          aria-label="Loading artifacts"
        >
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
              key={i}
              className={view === "grid" ? "h-[180px]" : "h-10"}
            />
          ))}
        </div>
      )}
      {q.isSuccess && items.length === 0 && (
        <Empty
          icon={<LibraryIcon />}
          title={filtered ? "No artifacts match these filters" : emptyTitle}
          description={
            filtered ? (
              "Try removing a filter."
            ) : canCreate ? (
              // What upload opens, before a file is picked (Design, #780).
              <>
                {emptyText}
                <span className="mt-[4px] block text-[length:var(--oa-text-xs)]">
                  {KINDS_LINE}
                </span>
              </>
            ) : (
              emptyText
            )
          }
          action={filtered ? undefined : emptyAction}
        />
      )}
      {items.length > 0 && (
        <div className={view === "grid" ? GRID : LIST}>
          {items.map((a) =>
            view === "grid" ? (
              <ArtifactCard
                key={a.id}
                artifact={a}
                meId={meId}
                showSpace={!space}
              />
            ) : (
              <ArtifactRow key={a.id} artifact={a} showSpace={!space} />
            ),
          )}
        </div>
      )}
      <div ref={sentinel} className="h-px" />
    </>
  );

  const revokedName = revoked?.name || space?.name || "this space";
  const revokedPanel = (
    <Empty
      icon={<LibraryIcon />}
      title={`You no longer have access to ${revokedName}.`}
      description="Your role in it changed or the space was deleted. Ask a space manager if you think this is a mistake."
      action={
        <Button
          size="sm"
          variant="outline"
          className="text-[length:var(--oa-text-sm)]"
          onClick={() => {
            setRevoked(null);
            go("/", {});
          }}
        >
          Back to Library
        </Button>
      }
    />
  );

  return (
    <section className={PAGE}>
      <div className={BAR}>
        <div className="min-w-0">
          <h1 className={H1}>{spaceName ?? "Library"}</h1>
          {myRole && !personal && (
            <p className="mt-[2px] text-[length:var(--oa-text-sm)] text-muted-foreground">
              {ROLE_LINE[myRole]}
            </p>
          )}
        </div>
        <span className="flex-1" />
        {/* No Upload inside a space you can only view (Design D4). */}
        {(!space || canPublishHere) && (
          <DropZone button allowed={canCreate} spaceId={uploadSpace} />
        )}
      </div>
      {/* One tree whether or not /me has loaded: the results never remount
          when the tabs appear (a remount detaches every card mid-use). */}
      <Tabs
        value={scope}
        onValueChange={(id) =>
          go(PATH[id as Scope], space ? { space: space.id } : {})
        }
        className="gap-[var(--oa-space-4)]"
      >
        {/* The strip scrolls, so the hairline is an inset shadow, the
            underline sits on the bottom edge and the focus ring is inset. */}
        {me.status === "authed" && (
          <TabsList
            variant="line"
            className="h-[34px] w-full justify-start gap-[var(--oa-space-4)] overflow-x-auto rounded-none p-0 shadow-[inset_0_-1px_0_var(--color-border)] [scrollbar-width:none]"
          >
            {TABS.filter(
              (t) =>
                (!guest || t.id === "shared") &&
                // Inside a space: All, Mine and Shared with me.
                !(space && t.id === "team"),
            ).map((t) => (
              <TabsTrigger
                key={t.id}
                value={t.id}
                className="h-full flex-none px-0 text-[length:var(--oa-text-sm)] group-data-[orientation=horizontal]/tabs:after:bottom-0 group-data-[orientation=horizontal]/tabs:after:h-[2px] focus-visible:outline-offset-[-2px]"
              >
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        )}
        {/* Not a tab stop: Tab goes from the tabs straight to the filters. */}
        <TabsContent value={scope} tabIndex={-1} className={PAGE}>
          {showRevoked ? revokedPanel : results}
        </TabsContent>
      </Tabs>
    </section>
  );
}
