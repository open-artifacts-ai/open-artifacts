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
import { isSending, useThreads } from "../../api/comments";
import { isEmbed } from "../../embed";
import type { createBridge } from "../bridge";
import { type Decision, decisionsOf } from "./decisionsModel";
import { type LiveReplies, useLiveReplies } from "./liveReplies";
import { lostKey, putLost } from "./lostPosts";
import {
  arrange,
  createGate,
  type FramePosition,
  frameThreads,
  type Positions,
} from "./model";
import { draftBadge, threadBadge } from "./pinBadge";

type Bridge = ReturnType<typeof createBridge>;

/** A post that failed after its box had closed: the text to put back and why. `clear` drops it once a box has taken it. */
export type Lost = { text: string; error: unknown; clear?: () => void };

export type PinPoint = { x: number; y: number; page?: number };
/** A comment being started: on selected text, or on a placed pin (the server stamps the pin's contentHash). */
export type Draft = { anchor: SelectionAnchor } | { pin: PinPoint } | null;
/** Formats that take pins (#1490); the server refuses them on html. */
export type PinFormat = "image" | "pdf";

export type CommentsApi = {
  /** Comments are on for this artifact and this viewer isn't an embed. */
  enabled: boolean;
  canComment: boolean;
  /** Owner or editor, signed in: may @mention agents (the server refuses anyone else). */
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
  /** The reader turned Pin on themselves (not the default an image opens in). */
  pinChosen: boolean;
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
  /** Replies that arrived while the page was open (#2179). */
  live: LiveReplies;
  ordered: readonly CommentThread[];
  orphans: readonly CommentThread[];
  positions: Positions;
  active: string | null;
  /** Select a card; `frame` also scrolls to and flashes its highlight. */
  select: (id: string | null, frame?: boolean) => void;
  /** Select, frame and bring the card into view and focus, even when it is already active. */
  reveal: (id: string) => void;
  /** The last reveal: its card scrolls and takes focus when `tick` changes. */
  revealed: { id: string | null; tick: number };
  /** The last `revealed.tick` a card focused for: a remounted card must not focus again. */
  revealDone: { current: number };
  draft: Draft;
  /**
   * #2019: a pin being placed whose box opens beside its flag, where it was
   * clicked, in frame-viewport pixels. Null: the box is in the comments list.
   */
  pinBeside: { x: number; y: number } | null;
  /** Close the draft. `posted`: keep its quote painted until the list carries the new thread (#1834). */
  cancelDraft: (posted?: boolean) => void;
  /** A new comment that failed after its box closed: the draft opens again with its text and the error. */
  draftSeed: Lost | null;
  reopenDraft: (d: NonNullable<Draft>, lost: Lost) => void;
  /** The draft's composer has (or no longer has) text the reader typed. */
  setDraftDirty: (dirty: boolean, unmounting?: boolean) => void;
  /** What the reader typed in the draft's box, kept while the list is closed. */
  draftText: { current: string };
  setDraftText: (text: string) => void;
  showResolved: boolean;
  setShowResolved: (v: boolean) => void;
  /** #2381: the pane shows the comments, or the decided asks. */
  view: "comments" | "decisions";
  setView: (v: "comments" | "decisions") => void;
  /** Every decided ask of the artifact, newest decision first. */
  decisions: readonly Decision[];
  /** The decision whose thread is open in place (its "← Decisions" back row), if any. */
  openDecision: string | null;
  setOpenDecision: (threadId: string | null) => void;
  guestName: string;
  setGuestName: (v: string) => void;
  /** Bridge callbacks. Every argument is a hint from page code. */
  onSelect: (a: SelectionAnchor) => void;
  onPositions: (
    p: { id: string; state: FramePosition["state"]; top: number | null }[],
    ghost?: { x: number; y: number },
  ) => void;
  onOpen: (id: string) => void;
  onPin: (p: PinPoint, at?: { x: number; y: number }) => void;
  /** Esc in the frame: leaves pin mode (page code can send it; it only ever leaves). */
  onEscape: () => void;
  /** #1732: text is selected in the frame and the reader may comment on it (Select mode). */
  hasSelection: boolean;
  /** The frame's selection state (a hint from page code; only ever offers the tap). */
  onSelection: (has: boolean) => void;
  /** Tap on "Comment on selection": the frame runs its own Comment path. */
  commentOnSelection: () => void;
  /**
   * The reader clicked away (or closed the list): an empty draft goes with its
   * highlight; a typed one stays, only the live text selection clears.
   */
  dropDraft: (clearFrame?: boolean) => void;
  /** The frame saw a pointer go down on the page. */
  onAway: () => void;
  /** The frame said hello: send it the mode and threads again. */
  resync: () => void;
};

/**
 * Where Esc belongs to someone else: a text field, or a modal above the viewer.
 * Our own phone sheet is `role="dialog"` without `aria-modal` (and the wide
 * overlay is not modal), so a reader's Esc still leaves pin mode there. Radix
 * dialogs set `aria-modal="true"` and `data-state="open"`; the alert dialog is
 * matched by role for anything else.
 */
const MODAL_OR_FIELD =
  "input, textarea, select, [aria-modal='true'], [data-state='open'][role='dialog'], [role='alertdialog']";

const Ctx = createContext<CommentsApi | null>(null);
export const CommentsProvider = Ctx.Provider;
export function useCommentsApi(): CommentsApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("CommentsProvider missing");
  return c;
}

/**
 * How long a posted draft's quote stays painted if the list never shows its
 * thread (#1834): long enough for a slow refetch, short enough that a server
 * which normalises the quote does not leave a highlight behind.
 */
const HELD_QUOTE_MS = 1500;

/** Signed-out visitors may comment on public artifacts (the approved spec) unless commenters is "signed-in" (#2080); dataWriters is a separate, live-data setting. */
export const guestsMayComment = (a: ArtifactSummary) =>
  a.visibility === "public" && a.commenters !== "signed-in";

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
  besideOk = false,
  viewerName = null,
}: {
  /** #2019: the comment box may open beside the flag (not a phone sheet or full screen). */
  besideOk?: boolean;
  /** The signed-in viewer's name, for the initials on the flag being placed. */
  viewerName?: string | null;
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
  const live = useLiveReplies(id, all, !q.isFetching);
  const [positions, setPositions] = useState<Positions>(new Map());
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [draftSeed, setDraftSeed] = useState<Lost | null>(null);
  const [pinAt, setPinAt] = useState<{ x: number; y: number } | null>(null);
  // #1834: a draft that was just posted stays painted until the refetched list
  // carries its thread, so posting turns the draft highlight into the thread's
  // without a frame in between. Cancel drops it at once.
  const [heldQuote, setHeldQuote] = useState<SelectionAnchor | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [view, setView] = useState<"comments" | "decisions">("comments");
  const [openDecision, setOpenDecision] = useState<string | null>(null);
  const decisions = useMemo(() => decisionsOf(all ?? []), [all]);
  const [guestName, setGuestName] = useState("");
  const [hello, setHello] = useState(0);
  const [selected, setSelected] = useState(false);

  const mayComment = canComment(artifact, authed, readOnly);
  // #1657: an image opens in Pin mode and a pdf in Select (spec 6); the
  // reader's choice, once made, holds for this view.
  const [wantPin, setWantPin] = useState<boolean | null>(null);
  const pins = wantPin ?? pinFormat === "image";
  // #1698: a pin mode the reader turned on is theirs to keep and to leave with
  // Esc; the one an image opens in is only a default, so Esc goes on to close
  // what it was aimed at (full screen, the phone sheet).
  const pinChosen = wantPin === true;
  const chosenRef = useRef(pinChosen);
  chosenRef.current = pinChosen;
  // Pin mode only where pins are offered and the viewer can comment.
  const mode: "select" | "pin" =
    pins && pinFormat !== null && mayComment ? "pin" : "select";
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Esc leaves a pin mode the reader chose. Capture phase, and stopped: in full
  // screen the exit handler is on the document too, and must not also run.
  useEffect(() => {
    if (mode !== "pin" || !pinChosen) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The key is not ours when an IME is composing, when a text field has it
      // (the composer, the mention menu and the reply box close on Esc), or when
      // a modal sits above the viewer (#1698 review).
      if (e.isComposing) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || t.closest(MODAL_OR_FIELD) !== null)
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      setWantPin(false);
    };
    document.addEventListener("keydown", k, true);
    return () => document.removeEventListener("keydown", k, true);
  }, [mode, pinChosen]);
  // The frame's own copy of what to draw: ids and anchors only.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `hello` re-sends after the frame reloads
  useEffect(() => {
    const b = getBridge();
    if (!b) return;
    // `?.`: older test doubles of the bridge have no comment methods.
    b.setCommentsMode?.(enabled ? (mayComment ? mode : "view") : "off");
    // A pin being composed is drawn as a ghost until it posts or is cancelled.
    const pin =
      draft && "pin" in draft
        ? {
            ...draft.pin,
            badge: draftBadge(
              authed ? (viewerName ?? "") : guestName.trim() || "Guest",
            ),
          }
        : undefined;
    // #1834: the quote being written about stays highlighted while the
    // composer takes the page's selection away.
    const quote: SelectionAnchor | undefined =
      (draft && "anchor" in draft ? draft.anchor : heldQuote) ?? undefined;
    if (enabled)
      b.setComments?.(
        frameThreads(
          threads,
          active,
          contentHash,
          pinFormat ? threadBadge(!authed || readOnly) : undefined,
        ),
        pin,
        quote,
      );
  }, [
    enabled,
    mayComment,
    mode,
    threads,
    active,
    draft,
    heldQuote,
    contentHash,
    hello,
    getBridge,
    pinFormat,
    authed,
    viewerName,
    guestName,
    readOnly,
  ]);

  // #1834: the held quote goes as soon as its thread is in the list, which is
  // what paints it from then on. The refetch usually settles BEFORE the post
  // resolves, so this has to look for the thread, not wait for a change; and a
  // list that never carries it (or normalises the quote) must not leave the
  // highlight on, so the hold also expires.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the payload and the hold
  useEffect(() => {
    if (!heldQuote) return;
    const there = (all ?? []).some(
      (t) =>
        // A thread still sending is not painted (the frame knows only real ids).
        !isSending(t.id) &&
        t.anchor.kind === "text" &&
        t.anchor.exact === heldQuote.exact &&
        t.anchor.prefix === heldQuote.prefix &&
        t.anchor.suffix === heldQuote.suffix,
    );
    if (there) {
      setHeldQuote(null);
      return;
    }
    const t = setTimeout(() => setHeldQuote(null), HELD_QUOTE_MS);
    return () => clearTimeout(t);
  }, [all, heldQuote]);

  const ids = useRef(new Set<string>());
  ids.current = new Set((all ?? []).map((t) => t.id));
  const gates = useRef({
    select: createGate(5, 1000),
    positions: createGate(20, 1000),
    open: createGate(5, 1000),
    pin: createGate(5, 1000),
    away: createGate(20, 1000),
  });
  const dirty = useRef(false);
  // Typed text outlives the composer's unmount (the list closing): closing keeps such a draft.
  const typed = useRef(false);
  const draftText = useRef("");
  const setDraftText = useCallback((t: string) => {
    draftText.current = t;
  }, []);
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
  const [revealed, setRevealed] = useState<{ id: string | null; tick: number }>(
    { id: null, tick: 0 },
  );
  const revealDone = useRef(0);
  const reveal = useCallback(
    (tid: string) => {
      select(tid, true);
      setRevealed((r) => ({ id: tid, tick: r.tick + 1 }));
    },
    [select],
  );
  const onSelect = useCallback((anchor: SelectionAnchor) => {
    // A pre-filled draft the reader must submit; page code can send this any time.
    if (!gates.current.select()) return;
    // A reader who can't comment is in the runtime's "view" mode and sends none; page code could still forge one.
    if (!mayRef.current) return;
    if (draftRef.current && (dirty.current || typed.current)) {
      // Never swap the draft under typed words: show it, so it can be sent or discarded.
      surface.current();
      return;
    }
    dirty.current = false;
    typed.current = false;
    draftText.current = "";
    setDraft({ anchor });
    surface.current();
  }, []);
  const besideRef = useRef(besideOk);
  besideRef.current = besideOk;
  const onPin = useCallback((pin: PinPoint, at?: { x: number; y: number }) => {
    // Page code can send this any time: only a click in pin mode counts, and
    // only for a viewer who can comment.
    if (modeRef.current !== "pin" || !mayRef.current) return;
    if (!gates.current.pin()) return;
    if (draftRef.current && (dirty.current || typed.current)) {
      // Never swap the draft under typed words: show it, so it can be sent or discarded.
      surface.current();
      return;
    }
    dirty.current = false;
    typed.current = false;
    draftText.current = "";
    setDraft({ pin });
    setPinAt(at ?? null);
    // #1698: a chosen pin mode holds for the view, so the next pin is one
    // click away; the default an image opens in falls back to Select.
    if (!chosenRef.current) setWantPin(false);
    // #2019: beside the flag, the box needs no list; on a phone the sheet opens.
    if (!(at && besideRef.current)) surface.current();
  }, []);
  const selectedRef = useRef(false);
  selectedRef.current = selected;
  const dropDraft = useCallback(
    (clearFrame = true) => {
      const had = draftRef.current !== null;
      if (had && !typed.current && !dirty.current) {
        typed.current = false;
        draftText.current = "";
        setDraft(null);
      }
      // A typed draft keeps its anchor highlight (the shell paints it); only the live selection goes.
      if (clearFrame && (had || selectedRef.current)) {
        getBridge()?.clearSelection?.();
        setSelected(false);
      }
    },
    [getBridge],
  );
  const onAway = useCallback(() => {
    if (gates.current.away()) dropDraft(false);
  }, [dropDraft]);
  // A pointer down in the shell, outside the comments surface and the offers
  // to comment, ends the selection (the frame sees its own).
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target;
      if (
        t instanceof Element &&
        t.closest(
          "[data-oa-keep-selection],[role='menu'],[role='dialog'],[role='alertdialog']",
        )
      )
        return;
      dropDraft();
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [dropDraft]);
  const onEscape = useCallback(() => {
    // Same rule as the shell's own Esc: only a chosen pin mode is left.
    if (chosenRef.current) setWantPin(false);
  }, []);
  const onSelection = useCallback((has: boolean) => {
    // Only where the reader may comment, in Select mode; page code can send this any time.
    setSelected(has && mayRef.current && modeRef.current === "select");
  }, []);
  const commentOnSelection = useCallback(() => {
    getBridge()?.commentOnSelection?.();
    setSelected(false);
    // Also open the list: page code can claim a selection, so the header
    // button must still reach comments when the frame has nothing to quote.
    surface.current();
  }, [getBridge]);
  // A mode change or a lost right drops the offer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on these
  useEffect(() => setSelected(false), [mode, mayComment, enabled]);
  const onPositions = useCallback<CommentsApi["onPositions"]>((list, ghost) => {
    // #2386: the flag moved (the page scrolled): the box beside it follows. Not
    // rate-limited with the list; it only moves a box a pin already opened.
    if (ghost)
      setPinAt((prev) =>
        prev && (prev.x !== ghost.x || prev.y !== ghost.y) ? ghost : prev,
      );
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
      pinChosen,
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
      live,
      ordered,
      orphans,
      positions,
      active,
      select,
      reveal,
      revealed,
      revealDone,
      draft,
      pinBeside: besideOk && draft && "pin" in draft ? pinAt : null,
      cancelDraft: (posted = false) => {
        dirty.current = false;
        typed.current = false;
        draftText.current = "";
        if (posted && draft && "anchor" in draft) setHeldQuote(draft.anchor);
        setDraft(null);
        setDraftSeed(null);
      },
      draftSeed,
      reopenDraft: (d, lost) => {
        // A draft the reader has since started keeps its place: the failed one
        // waits behind a "Restore" line (lostPosts), text and error kept.
        if (draftRef.current) {
          putLost(lostKey.draft(id, d), { ...lost, draft: d });
          return;
        }
        setHeldQuote(null);
        setDraftSeed(lost);
        setPinAt(null);
        setDraft(d);
        surface.current();
      },
      draftText,
      setDraftText,
      setDraftDirty: (d, unmounting = false) => {
        dirty.current = d;
        if (!unmounting) typed.current = d;
      },
      showResolved,
      setShowResolved,
      view,
      setView,
      decisions,
      openDecision,
      setOpenDecision,
      guestName,
      setGuestName,
      onSelect,
      onPositions,
      onOpen,
      onPin,
      onEscape,
      hasSelection: selected,
      onSelection,
      commentOnSelection,
      dropDraft,
      onAway,
      resync: () => {
        setSelected(false);
        setHello((n) => n + 1);
      },
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
      live,
      ordered,
      orphans,
      positions,
      active,
      select,
      reveal,
      revealed,
      draft,
      pinAt,
      besideOk,
      draftSeed,
      showResolved,
      view,
      decisions,
      openDecision,
      guestName,
      pinFormat,
      contentHash,
      mode,
      pinChosen,
      onSelect,
      onPositions,
      onOpen,
      onPin,
      onEscape,
      selected,
      onSelection,
      commentOnSelection,
      dropDraft,
      onAway,
      setDraftText,
    ],
  );
}
