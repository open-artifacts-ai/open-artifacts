import type {
  ArtifactSummary,
  CommentThread,
  SelectionAnchor,
} from "@oa/shared";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useThreads } from "../../api/comments";
import { isEmbed } from "../../embed";
import type { createBridge } from "../bridge";
import {
  arrange,
  createGate,
  type FramePosition,
  frameThreads,
  type Positions,
} from "./model";

type Bridge = ReturnType<typeof createBridge>;

export type Draft = { anchor: SelectionAnchor } | null;

export type CommentsApi = {
  /** Comments are on for this artifact and this viewer isn't an embed. */
  enabled: boolean;
  canComment: boolean;
  /** Not signed in: composers ask for a display name. */
  guest: boolean;
  artifactId: string;
  /** The version the viewer shows. */
  version: number;
  /** Viewing a pinned older version: the composer says so. */
  older: boolean;
  /** Open threads of the whole artifact (the toolbar count). */
  open: number;
  loading: boolean;
  error: unknown;
  refetch: () => void;
  /** Threads shown here: all of them, or the ones made on a pinned older version. */
  threads: readonly CommentThread[];
  ordered: readonly CommentThread[];
  orphans: readonly CommentThread[];
  positions: Positions;
  active: string | null;
  /** Select a card; `frame` also scrolls to and flashes its highlight. */
  select: (id: string | null, frame?: boolean) => void;
  draft: Draft;
  cancelDraft: () => void;
  showResolved: boolean;
  setShowResolved: (v: boolean) => void;
  guestName: string;
  setGuestName: (v: string) => void;
  /** Bridge callbacks. Every argument is a hint from page code. */
  onSelect: (a: SelectionAnchor) => void;
  onPositions: (
    p: { id: string; state: FramePosition["state"]; top: number | null }[],
  ) => void;
  onOpen: (id: string) => void;
  /** The frame said hello: send it the mode and threads again. */
  resync: () => void;
};

const Ctx = createContext<CommentsApi | null>(null);
export const CommentsProvider = Ctx.Provider;
export function useCommentsApi(): CommentsApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("CommentsProvider missing");
  return c;
}

/** A guest can comment where the artifact lets signed-out visitors write. */
export const canComment = (a: ArtifactSummary, authed: boolean) =>
  a.can?.comment ??
  (authed || (a.visibility === "public" && a.dataWriters === "viewers"));

export function useCommentsController({
  artifact,
  version,
  authed,
  getBridge,
  openSurface,
}: {
  artifact: ArtifactSummary;
  version: number;
  authed: boolean;
  getBridge: () => Bridge | null;
  /** A frame event that needs the list in view (the panel or sheet, if folded). */
  openSurface: () => void;
}): CommentsApi {
  const id = artifact.id;
  const enabled = artifact.comments !== false && !isEmbed();
  const q = useThreads(id, enabled, !authed);
  const all = q.data?.threads;
  const older = version !== artifact.currentVersion;
  const threads = useMemo(
    () =>
      older ? (all ?? []).filter((t) => t.version === version) : (all ?? []),
    [all, older, version],
  );
  const [positions, setPositions] = useState<Positions>(new Map());
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [hello, setHello] = useState(0);

  // The frame's own copy of what to draw: ids and anchors only.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `hello` re-sends after the frame reloads
  useEffect(() => {
    const b = getBridge();
    if (!b) return;
    // `?.`: older test doubles of the bridge have no comment methods.
    b.setCommentsMode?.(enabled ? "select" : "off");
    if (enabled) b.setComments?.(frameThreads(threads, active));
  }, [enabled, threads, active, hello, getBridge]);

  const ids = useRef(new Set<string>());
  ids.current = new Set((all ?? []).map((t) => t.id));
  const gates = useRef({
    select: createGate(5, 1000),
    positions: createGate(20, 1000),
    open: createGate(5, 1000),
  });
  const surface = useRef(openSurface);
  surface.current = openSurface;

  const select = useCallback(
    (tid: string | null, frame = false) => {
      setActive(tid);
      if (tid && frame) getBridge()?.focusComment?.(tid);
    },
    [getBridge],
  );
  const onSelect = useCallback((anchor: SelectionAnchor) => {
    // A pre-filled draft the reader must submit; page code can send this any time.
    if (!gates.current.select()) return;
    setDraft({ anchor });
    surface.current();
  }, []);
  const onPositions = useCallback<CommentsApi["onPositions"]>((list) => {
    if (!gates.current.positions()) return;
    const next = new Map<string, FramePosition>();
    // Only ids in the shell's own list count.
    for (const p of list)
      if (ids.current.has(p.id)) next.set(p.id, { state: p.state, top: p.top });
    setPositions((prev) =>
      prev.size === next.size &&
      [...next].every(
        ([k, v]) =>
          prev.get(k)?.state === v.state && prev.get(k)?.top === v.top,
      )
        ? prev
        : next,
    );
  }, []);
  const onOpen = useCallback((tid: string) => {
    if (!gates.current.open() || !ids.current.has(tid)) return;
    setActive(tid);
    surface.current();
  }, []);

  const { ordered, orphans } = useMemo(
    () => arrange(threads, positions),
    [threads, positions],
  );
  const refetch = q.refetch;
  return useMemo(
    () => ({
      enabled,
      canComment: canComment(artifact, authed),
      guest: !authed,
      artifactId: id,
      version,
      older,
      open: q.data?.open ?? 0,
      loading: q.isPending && enabled,
      error: q.error,
      refetch: () => void refetch(),
      threads,
      ordered,
      orphans,
      positions,
      active,
      select,
      draft,
      cancelDraft: () => setDraft(null),
      showResolved,
      setShowResolved,
      guestName,
      setGuestName,
      onSelect,
      onPositions,
      onOpen,
      resync: () => setHello((n) => n + 1),
    }),
    [
      enabled,
      artifact,
      authed,
      id,
      version,
      older,
      q.data?.open,
      q.isPending,
      q.error,
      refetch,
      threads,
      ordered,
      orphans,
      positions,
      active,
      select,
      draft,
      showResolved,
      guestName,
      onSelect,
      onPositions,
      onOpen,
    ],
  );
}
