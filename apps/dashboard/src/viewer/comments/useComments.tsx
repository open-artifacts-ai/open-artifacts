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
import { ApiClientError } from "../../api/client";
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

export type PinPoint = { x: number; y: number; page?: number };
/** A comment being started: on selected text, or on a placed pin (the server stamps the pin's contentHash). */
export type Draft = { anchor: SelectionAnchor } | { pin: PinPoint } | null;
/** Formats that take pins (#1490); the server refuses them on html. */
export type PinFormat = "image" | "pdf";

export type CommentsApi = {
  /** Comments are on for this artifact and this viewer isn't an embed. */
  enabled: boolean;
  canComment: boolean;
  /** Owner or editor, signed in: may @mention and assign agents (the server refuses anyone else). */
  canMention: boolean;
  /** A guest or restricted member: the server refuses their writes as read-only. */
  capped: boolean;
  /** Not signed in: composers ask for a display name. */
  guest: boolean;
  artifactId: string;
  /** The version the viewer shows. */
  version: number;
  /** The shown version's format when it takes pins, else null. */
  pinFormat: PinFormat | null;
  /** The shown version's content hash, when the server gave one. */
  contentHash: string | null;
  /** The tool in use; "pin" only where pins are offered and the viewer can comment. */
  mode: "select" | "pin";
  setMode: (m: "select" | "pin") => void;
  /** Viewing a pinned older version: the composer says so. */
  older: boolean;
  /** Open threads of the whole artifact. */
  open: number;
  /** Open threads in the list shown here, and so the toolbar count (differs from `open` on a pinned older version). */
  listedOpen: number;
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
  /** The draft's composer has (or no longer has) text the reader typed. */
  setDraftDirty: (dirty: boolean) => void;
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
  onPin: (p: PinPoint) => void;
  /** Esc in the frame: leaves pin mode (page code can send it; it only ever leaves). */
  onEscape: () => void;
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

/** Signed-out visitors may comment on public artifacts (the approved spec); dataWriters is a separate, live-data setting. */
export const guestsMayComment = (a: ArtifactSummary) =>
  a.visibility === "public";

export const canComment = (
  a: ArtifactSummary,
  authed: boolean,
  readOnly = false,
) => !readOnly && (a.can?.comment ?? (authed || guestsMayComment(a)));

export function useCommentsController({
  artifact,
  version,
  pinned,
  authed,
  readOnly = false,
  pinFormat = null,
  contentHash = null,
  getBridge,
  openSurface,
}: {
  pinFormat?: PinFormat | null;
  contentHash?: string | null;
  /** The address names this version (not following Current). */
  pinned: boolean;
  artifact: ArtifactSummary;
  version: number;
  authed: boolean;
  /** The caller is capped (Me.auth.readOnly): no comment writes. */
  readOnly?: boolean;
  getBridge: () => Bridge | null;
  /** A frame event that needs the list in view (the panel or sheet, if folded). */
  openSurface: () => void;
}): CommentsApi {
  const id = artifact.id;
  // Absent `comments`: a server without them (older than #1496): nothing to show.
  const wanted = artifact.comments === true && !isEmbed();
  const q = useThreads(id, wanted, !authed);
  // A 404 or comments_off from the list means comments are unavailable here:
  // no panel, no column, no badge and no error. The query stays enabled, so a
  // comments event, a refetch of the summary (comments: true again) or a focus
  // refetch can bring them back; the error is replaced by the next answer.
  const unavailable =
    q.error instanceof ApiClientError &&
    (q.error.status === 404 || q.error.code === "comments_off");
  const enabled = wanted && !unavailable;
  const all = q.data?.threads;
  // Pinned to an older version by the address: not merely "behind" a current
  // version that a live event just raised before the swap.
  const older = pinned && version !== artifact.currentVersion;
  const threads = useMemo(
    () =>
      older
        ? (all ?? []).filter(
            // A whole-page note isn't tied to a version: it shows on every one.
            (t) => t.version === version || t.anchor.kind === "note",
          )
        : (all ?? []),
    [all, older, version],
  );
  const [positions, setPositions] = useState<Positions>(new Map());
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [hello, setHello] = useState(0);

  const mayComment = canComment(artifact, authed, readOnly);
  // #1657: an image opens in Pin mode and a pdf in Select (spec 6); the
  // reader's choice, once made, holds for this view.
  const [wantPin, setWantPin] = useState<boolean | null>(null);
  const pins = wantPin ?? pinFormat === "image";
  // Pin mode only where pins are offered and the viewer can comment.
  const mode: "select" | "pin" =
    pins && pinFormat !== null && mayComment ? "pin" : "select";
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Esc leaves pin mode first. Capture phase, and stopped: in full screen the
  // exit handler is on the document too, and must not also run.
  useEffect(() => {
    if (mode !== "pin") return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setWantPin(false);
    };
    document.addEventListener("keydown", k, true);
    return () => document.removeEventListener("keydown", k, true);
  }, [mode]);
  // The frame's own copy of what to draw: ids and anchors only.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `hello` re-sends after the frame reloads
  useEffect(() => {
    const b = getBridge();
    if (!b) return;
    // `?.`: older test doubles of the bridge have no comment methods.
    b.setCommentsMode?.(enabled ? (mayComment ? mode : "view") : "off");
    // A pin being composed is drawn as a ghost until it posts or is cancelled.
    const pin = draft && "pin" in draft ? draft.pin : undefined;
    if (enabled)
      b.setComments?.(frameThreads(threads, active, contentHash), pin);
  }, [
    enabled,
    mayComment,
    mode,
    threads,
    active,
    draft,
    contentHash,
    hello,
    getBridge,
  ]);

  const ids = useRef(new Set<string>());
  ids.current = new Set((all ?? []).map((t) => t.id));
  const gates = useRef({
    select: createGate(5, 1000),
    positions: createGate(20, 1000),
    open: createGate(5, 1000),
    pin: createGate(5, 1000),
  });
  const dirty = useRef(false);
  const mayRef = useRef(mayComment);
  mayRef.current = mayComment;
  const draftRef = useRef<Draft>(null);
  draftRef.current = draft;
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
    // A reader who can't comment is in the runtime's "view" mode and sends none; page code could still forge one.
    if (!mayRef.current) return;
    // Never swap the quote under words the reader is typing.
    if (draftRef.current && dirty.current) return;
    dirty.current = false;
    setDraft({ anchor });
    surface.current();
  }, []);
  const onPin = useCallback((pin: PinPoint) => {
    // Page code can send this any time: only a click in pin mode counts, and
    // only for a viewer who can comment.
    if (modeRef.current !== "pin" || !mayRef.current) return;
    if (!gates.current.pin()) return;
    if (draftRef.current && dirty.current) return;
    dirty.current = false;
    setDraft({ pin });
    setWantPin(false);
    surface.current();
  }, []);
  const onEscape = useCallback(() => setWantPin(false), []);
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
      canComment: mayComment,
      canMention:
        authed &&
        !readOnly &&
        (artifact.can?.edit ??
          (artifact.access === "owner" || artifact.access === "editor")),
      capped: readOnly,
      guest: !authed,
      artifactId: id,
      version,
      pinFormat,
      contentHash,
      mode,
      setMode: (m) => setWantPin(m === "pin"),
      older,
      open: q.data?.open ?? 0,
      listedOpen: older
        ? threads.filter((t) => t.status === "open").length
        : (q.data?.open ?? 0),
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
      cancelDraft: () => {
        dirty.current = false;
        setDraft(null);
      },
      setDraftDirty: (d) => {
        dirty.current = d;
      },
      showResolved,
      setShowResolved,
      guestName,
      setGuestName,
      onSelect,
      onPositions,
      onOpen,
      onPin,
      onEscape,
      resync: () => setHello((n) => n + 1),
    }),
    [
      enabled,
      mayComment,
      artifact.can?.edit,
      artifact.access,
      readOnly,
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
      pinFormat,
      contentHash,
      mode,
      onSelect,
      onPositions,
      onOpen,
      onPin,
      onEscape,
    ],
  );
}
