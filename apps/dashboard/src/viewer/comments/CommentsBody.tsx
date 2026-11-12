import {
  type ArtifactAgent,
  COMMENT_BODY_MAX,
  COMMENT_GUEST_NAME_MAX,
  type CommentAuthor,
  type Comment as CommentT,
  type CommentThread,
  MENTIONS_MAX,
  viewerPath,
} from "@oa/shared";
import { Button, Textarea } from "@oa/ui/shadcn";
import { useNavigate } from "@tanstack/react-router";
import { Check, FileText } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ApiClientError } from "../../api/client";
import {
  commentError,
  TooManyMentions,
  useArtifactAgents,
  useCommentErrorCtx,
  useCreateThread,
  useDeleteComment,
  useEditComment,
  useReply,
  useSetThreadStatus,
} from "../../api/comments";
import { isEmbed } from "../../embed";
import { CTXT, TXT } from "../ui";
import { exactDate, versionDate } from "../versionDate";
import { AuthorFace, AuthorSub, initials } from "./AuthorFace";
import { useActionRowSlot } from "./actionRow";
import {
  AskBlock,
  actor,
  asksForMe,
  Delivery,
  DeliveryFaces,
  type Extras,
  extrasBody,
  MentionChips,
  MentionedText,
  MentionMenu,
  matchAgents,
  mentionedKeys,
  mentionQuery,
  newProblems,
  nextAskFor,
  removeMention,
} from "./asks";
import {
  focusRow,
  holdAnchor,
  NewReplyPill,
  scrollerOf,
  useKeepScroll,
} from "./keepScroll";
import { LIVE_TINT_MS } from "./liveReplies";
import { numbering, pinChanged, pinNumbering } from "./model";
import { ThreadAgents } from "./threadAgents";
import { type CommentsApi, useCommentsApi } from "./useComments";

const touch = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(pointer: coarse)").matches === true;

/** "Click to place a pin" on a pointer device, "Tap to place a pin" on touch. */
export const pinHint = () =>
  touch() ? "Tap to place a pin" : "Click to place a pin";

/** "Esc to cancel", on a device with a keyboard only: touch has the Select button. */
function EscHint({ esc }: { esc: boolean }) {
  // #1698: only where Esc actually leaves pin mode (a mode the reader chose).
  return esc && !touch() ? <span> · Esc to cancel</span> : null;
}

/** Select and Pin tools for images and pdf pages (#1490). */
function Tools({ api }: { api: CommentsApi }) {
  if (!api.pinFormat || !api.canComment) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Button
          size="xs"
          variant={api.mode === "select" ? "default" : "outline"}
          aria-pressed={api.mode === "select"}
          onClick={() => api.setMode("select")}
        >
          Select
        </Button>
        <Button
          size="xs"
          variant={api.mode === "pin" ? "default" : "outline"}
          aria-pressed={api.mode === "pin"}
          onClick={() => api.setMode("pin")}
        >
          Pin
        </Button>
      </div>
      {api.mode === "pin" && (
        <p className={`${TXT} ${MUTED}`}>
          <span>{pinHint()}</span>
          <EscHint esc={api.pinChosen} />
        </p>
      )}
    </div>
  );
}

/** Over the page while placing a pin when the list is a sheet that closed. */
export function PinBar() {
  const api = useCommentsApi();
  if (api.mode !== "pin") return null;
  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card px-3 py-1 shadow-md"
    >
      <span className={`${TXT} whitespace-nowrap`}>
        <span>{pinHint()}</span>
        <EscHint esc={api.pinChosen} />
      </span>
      <Button size="xs" variant="ghost" onClick={() => api.setMode("select")}>
        Select
      </Button>
    </div>
  );
}

const MUTED = "text-muted-foreground";

/**
 * #1657: in the phone sheet's short height (a pin's card), the action row
 * stays on screen instead of being cut at the bottom edge. The sheet carries
 * the named group; elsewhere these variants do nothing. The row needs its own
 * surface while it floats (content scrolls under it), and that surface is the
 * one it sits on: a thread card's, or the sheet's in the note composer.
 */
const STICKY =
  "group-data-[sheet-height=pin]/sheet:sticky group-data-[sheet-height=pin]/sheet:bottom-0 group-data-[sheet-height=pin]/sheet:z-10";
export const ACTIONS = `${STICKY} group-data-[sheet-height=pin]/sheet:bg-background`;
export const ACTIONS_PLAIN = `${STICKY} group-data-[sheet-height=pin]/sheet:bg-card`;

/** Everything below renders comment text as React text: never HTML. */

function GuestName({ api }: { api: CommentsApi }) {
  if (!api.guest) return null;
  return (
    <input
      className={`w-full rounded-md border border-input bg-background px-2 py-1 ${TXT}`}
      aria-label="Your name"
      placeholder="Your name"
      maxLength={COMMENT_GUEST_NAME_MAX}
      value={api.guestName}
      onChange={(e) => api.setGuestName(e.target.value)}
    />
  );
}

/** A guest's way to sign in, back to this page. `box` fills the composer's place. */
function SignInLink({ box = false }: { box?: boolean }) {
  return (
    <a
      className={
        box
          ? `${TXT} flex min-h-9 w-full items-center justify-center rounded-md border border-[var(--oa-border)] px-3 text-[var(--oa-accent-fg)] underline focus-visible:outline-2 focus-visible:outline-[var(--oa-focus)]`
          : `${TXT} text-[var(--oa-accent-fg)] underline`
      }
      href={`/sign-in?next=${encodeURIComponent(
        `${window.location.pathname}${window.location.search}`,
      )}`}
      target={isEmbed() ? "_blank" : undefined}
      rel="noopener noreferrer"
    >
      {box ? "Sign in to comment" : "Sign in"}
    </a>
  );
}

/** What the box really does: ⌘ Enter (Ctrl Enter elsewhere) sends. */
const isCoarse = () =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(pointer: coarse)").matches;

function SendHint({ id }: { id?: string }) {
  // A touch screen has no ⌘ or Ctrl key to press: show it for fine pointers only.
  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(pointer: coarse)").matches
  )
    return null;
  const mac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return (
    <span id={id} data-send-hint="" className={`${TXT} ${MUTED}`}>
      {mac ? "⌘ Enter" : "Ctrl Enter"} to send
    </span>
  );
}

/** The quoted line under a 3px amber bar, two lines at most (#2118). */
function QuoteBar({
  children,
  ...rest
}: { children: React.ReactNode } & React.HTMLAttributes<HTMLQuoteElement>) {
  return (
    <blockquote
      {...rest}
      className={`m-0 border-0 border-l-[3px] border-l-[color-mix(in_srgb,var(--oa-warning)_60%,transparent)] pl-2.5 ${TXT} ${MUTED} ${rest.className ?? ""}`}
    >
      <span className="line-clamp-2 min-w-0 break-words">{children}</span>
    </blockquote>
  );
}

/**
 * #2234: the outlined field. One line when empty, then it grows a line at a
 * time up to ~10 lines (240px; ~6 on a phone) and scrolls inside its own edge.
 */
export const FIELD =
  "min-h-[42px] max-h-[min(9rem,40svh)] md:max-h-[min(15rem,40svh)] resize-none overflow-y-auto border-input bg-card px-2.5 py-2 leading-[1.45] focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-[599px]:text-[16px] [@media(pointer:coarse)]:text-[16px]";
export const FIELD_MAX = 240;
export const FIELD_MAX_PHONE = 144;

/** Fallback for browsers without `field-sizing: content`: size to the text, capped. */
export function growField(el: HTMLTextAreaElement | null) {
  if (!el) return;
  if (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content"))
    return;
  const phone = !!window.matchMedia?.("(max-width: 767px)").matches;
  const max = Math.min(
    phone ? FIELD_MAX_PHONE : FIELD_MAX,
    window.innerHeight * 0.4 || Number.POSITIVE_INFINITY,
  );
  // Measuring with height:auto shortens the list and clamps the scroller:
  // put its scrollTop back.
  const box = scrollerOf(el);
  const at = box?.scrollTop ?? 0;
  el.style.height = "auto";
  const edge = el.offsetHeight - el.clientHeight; // borders (and a scrollbar)
  el.style.height = `${Math.min(el.scrollHeight + edge, max)}px`;
  if (box && box.scrollTop !== at) box.scrollTop = at;
}

/**
 * Focus without scrolling the document, then make the field visible inside
 * the panel's own scroller, between the sticky header and the action row.
 */
export function focusField(el: HTMLElement | null) {
  if (!el) return;
  el.focus({ preventScroll: true });
  const box = scrollerOf(el);
  if (!box) return;
  const head =
    box.querySelector<HTMLElement>("[data-comments-header]")?.offsetHeight ?? 0;
  const foot =
    box.querySelector<HTMLElement>("[data-oa-action-outlet]")?.offsetHeight ??
    0;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const top = b.top + head;
  const bottom = b.bottom - foot;
  if (r.top < top) box.scrollTop -= top - r.top;
  else if (r.bottom > bottom)
    box.scrollTop += Math.min(r.bottom - bottom, r.top - top);
}

/** A box with its buttons; `onSubmit` rejects with the failure to show. */
function Composer({
  placeholder,
  mentionPlaceholder,
  label,
  submit,
  extra,
  onSubmit,
  onCancel,
  initial = "",
  autoFocus = false,
  alwaysOpen = true,
  failure,
  onDirty,
  mentionable = false,
  actions = ACTIONS,
  float = false,
  buttonsRight = false,
  lead,
  card = false,
  keepOnEsc = false,
  quote,
}: {
  /** The composer as a card: quote on top, hint and button always visible (#2118). */
  card?: boolean;
  /** Esc is swallowed here and the draft stays (the box never closes). */
  keepOnEsc?: boolean;
  /** Shown at the top of the card, under an amber bar. */
  quote?: React.ReactNode;
  /** Offer @mentions: the agent list is fetched on the composer's first focus. */
  mentionable?: boolean;
  /** The action row's own surface while it floats in the short sheet (#1657). */
  actions?: string;
  /** Let the sheet's outlet take the row while it is short (#1711). */
  float?: boolean;
  /** The new-comment layout: Cancel and the accent submit at the right. */
  buttonsRight?: boolean;
  /** Shown at the left of the button row (a guest's Sign in link). */
  lead?: React.ReactNode;
  /** Called when the box gains or loses text the reader typed. */
  onDirty?: (dirty: boolean) => void;
  placeholder: string;
  /** The placeholder for someone who can mention agents here. */
  mentionPlaceholder?: string;
  label: string;
  submit: string;
  extra?: React.ReactNode;
  onSubmit: (body: string, extras: Extras) => Promise<unknown>;
  onCancel?: () => void;
  initial?: string;
  autoFocus?: boolean;
  /** Collapsed to one line until focused. */
  alwaysOpen?: boolean;
  failure?: (e: unknown) => React.ReactNode;
}) {
  const api = useCommentsApi();
  const { capped, canMention, guest } = api;
  const errCtx = useCommentErrorCtx();
  const [text, setText] = useState(initial);
  const [open, setOpen] = useState(alwaysOpen);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const once = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [menuOff, setMenuOff] = useState(false);
  const [activeOpt, setActiveOpt] = useState(0);
  const menuId = useId();
  const hintId = useId();
  const coarse = isCoarse();
  // The list is fetched lazily: first focus of a composer an owner/editor can
  // use (then kept), never on column open. A transient error is retried on the
  // next focus; a 404 (no route) stays answered.
  const [wantAgents, setWantAgents] = useState(false);
  const agentsQ = useArtifactAgents(
    api.artifactId,
    mentionable && wantAgents && api.canMention && api.canComment,
  );
  const agents = agentsQ.data;
  // #1711: in the short pin sheet the sheet's own outlet takes the row, so it
  // stays at the sheet's bottom for a long thread too. The outlet carries the
  // surface, the padding and the safe-area inset; the card keeps it elsewhere.
  const slot = useActionRowSlot(float && open);
  const retryAgents = () => {
    if (!wantAgents) setWantAgents(true);
    if (
      agentsQ.isError &&
      !agentsQ.isFetching &&
      !(agentsQ.error instanceof ApiClientError && agentsQ.error.status === 404)
    )
      void agentsQ.refetch();
  };
  const query = agents?.length ? mentionQuery(text.slice(0, caret)) : null;
  const found =
    query !== null && agents && !menuOff ? matchAgents(agents, query) : null;
  const matches = found ?? [];
  const menuOpen = matches.length > 0;
  const pickedAt = useRef<number | null>(null);
  const pick = (a: ArtifactAgent) => {
    const before = text.slice(0, caret).replace(/@[\w .-]{0,40}$/, "");
    setText(`${before}@${a.name} ${text.slice(caret)}`);
    const at = before.length + a.name.length + 2;
    setCaret(at);
    setMenuOff(true);
    setActiveOpt(0);
    pickedAt.current = at;
  };
  // Put the caret after the picked name in the same commit as the new text. A
  // frame later is too late: keys typed in between land before it (#1795).
  useLayoutEffect(() => {
    const at = pickedAt.current;
    if (at === null) return;
    pickedAt.current = null;
    ref.current?.focus();
    ref.current?.setSelectionRange(at, at);
  });
  useEffect(() => {
    if (autoFocus) focusField(ref.current);
  }, [autoFocus]);
  // Width changes (panel resize, rotation, late fonts, a restored hidden draft)
  // change how many lines the text takes.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let w = el.offsetWidth;
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth === w) return;
      w = el.offsetWidth;
      growField(el);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: text is what changes the height.
  useLayoutEffect(() => growField(ref.current), [text]);
  const body = text.trim();
  // Words in the box, or an edit in progress: a live swap must not drop them.
  const composing = body !== "" || initial !== "";
  useEffect(() => {
    onDirty?.(body !== "");
    return () => onDirty?.(false);
  }, [body, onDirty]);
  const go = async () => {
    if (!body || once.current) return;
    once.current = true;
    setBusy(true);
    setError(null);
    try {
      // Only agents whose @name is still in the text are mentioned.
      const keys = mentionedKeys(body, agents ?? []);
      if (keys.length > MENTIONS_MAX) throw new TooManyMentions();
      const mentions = keys.map((key) => ({ key }));
      await onSubmit(body, {
        mentions,
      });
      setText("");
      if (!alwaysOpen) setOpen(false);
    } catch (e) {
      setError(e);
    } finally {
      once.current = false;
      setBusy(false);
    }
  };
  const cancel = () => {
    setText(initial);
    setError(null);
    if (!alwaysOpen) setOpen(false);
    onCancel?.();
  };
  return (
    <div
      className={
        card
          ? "flex flex-col gap-2 rounded-lg border border-input bg-card p-3"
          : "flex flex-col gap-2"
      }
      data-oa-composing={composing ? "" : undefined}
    >
      {quote}
      <Textarea
        ref={ref}
        aria-label={label}
        placeholder={
          mentionable && canMention && api.canComment && mentionPlaceholder
            ? mentionPlaceholder
            : placeholder
        }
        value={text}
        maxLength={COMMENT_BODY_MAX}
        rows={1}
        data-oa-field=""
        className={`${CTXT} ${FIELD}`}
        onFocus={() => {
          setOpen(true);
          retryAgents();
        }}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart);
          setMenuOff(false);
          setActiveOpt(0);
        }}
        aria-describedby={card && !coarse ? hintId : undefined}
        aria-controls={menuOpen ? menuId : undefined}
        aria-activedescendant={menuOpen ? `${menuId}-${activeOpt}` : undefined}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={(e) => {
          if (menuOpen) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const n = matches.length;
              setActiveOpt(
                (i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n,
              );
              return;
            }
            if (
              (e.key === "Enter" || e.key === "Tab") &&
              !e.nativeEvent.isComposing &&
              !e.shiftKey &&
              !e.metaKey &&
              !e.ctrlKey
            ) {
              e.preventDefault();
              const a = matches[activeOpt];
              if (a) pick(a);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setMenuOff(true);
              return;
            }
          }
          if (
            e.key === "Enter" &&
            (e.metaKey || e.ctrlKey) &&
            !e.nativeEvent.isComposing
          ) {
            e.preventDefault();
            void go();
          }
          if (e.key === "Escape" && keepOnEsc) {
            e.stopPropagation();
            return;
          }
          if (e.key === "Escape" && (onCancel || !alwaysOpen)) {
            e.stopPropagation();
            cancel();
          }
        }}
      />
      {!canMention &&
        !guest &&
        !capped &&
        initial === "" &&
        /(^|\s)@/.test(text) && (
          <p className={`${TXT} text-muted-foreground`}>
            Only the owner and editors can wake agents.
          </p>
        )}
      {found && (
        <MentionMenu
          id={menuId}
          matches={matches}
          all={agents}
          active={activeOpt}
          onPick={pick}
        />
      )}
      {agents && agents.length > 0 && (
        <MentionChips
          text={text}
          agents={agents}
          onRemove={(a) => setText((t) => removeMention(t, a.name, agents))}
        />
      )}
      {error != null && (
        <p role="alert" className={`${TXT} text-destructive`}>
          {commentError(error, capped, errCtx)}
          {failure?.(error)}
        </p>
      )}
      {open &&
        (() => {
          const cancelBtn = (onCancel || !alwaysOpen) && (
            <Button size="xs" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          );
          // Portaled into the sheet's outlet, the row keeps its layout and
          // drops its own surface: the outlet is the surface (#1711).
          const surface = slot ? "" : actions;
          const row = buttonsRight ? (
            <div
              data-oa-actions=""
              className={`flex flex-col gap-2 ${surface}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                {lead}
                {card && <SendHint id={hintId} />}
                <div className="ml-auto flex items-center gap-2">
                  {extra}
                  {cancelBtn}
                  <Button
                    size="xs"
                    className={`bg-[var(--oa-accent)] text-[var(--oa-accent-text)] hover:bg-[var(--oa-accent-fg)]${card ? " h-8 px-4" : ""}`}
                    disabled={!body || busy}
                    onClick={() => void go()}
                  >
                    {submit}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div
              data-oa-actions=""
              className={`flex flex-wrap items-center gap-2 ${surface}`}
            >
              <Button
                size="xs"
                disabled={!body || busy}
                onClick={() => void go()}
              >
                {submit}
              </Button>
              {extra}
              {cancelBtn}
            </div>
          );
          return slot ? createPortal(row, slot) : row;
        })()}
    </div>
  );
}

export { initials };

/**
 * #2229: a header that is too tight for the faces gives way in order: the time
 * first (it stays in the name's tooltip), then the faces down to the summary
 * mark and its count, and only then the name truncates. Measured: while the
 * name is cut off, step once more; a new width starts over.
 */
function useTightHeader(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState(0);
  const width = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !active || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width.current) return;
      width.current = el.clientWidth;
      setStage(0);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);
  // Runs after every render: one step per cut-off name, until it fits or nothing is left to give.
  useLayoutEffect(() => {
    const name = ref.current?.querySelector<HTMLElement>("[data-author-name]");
    if (active && name && name.scrollWidth > name.clientWidth && stage < 2)
      setStage(stage + 1);
  });
  return { ref, stage: active ? stage : 0 };
}

function Who({
  a,
  at,
  edited,
  hideTime = false,
}: {
  a: CommentAuthor;
  at: string;
  edited: boolean;
  hideTime?: boolean;
}) {
  const isAgent = a.kind === "agent";
  return (
    <div className="flex min-w-0 items-start gap-2">
      <AuthorFace a={a} />
      <div className="flex min-w-0 flex-col self-center">
        <p className={`m-0 flex min-w-0 items-baseline gap-x-1 ${CTXT}`}>
          <b
            data-author-name=""
            className="min-w-0 truncate"
            title={hideTime ? `${a.name}, ${exactDate(at)}` : a.name}
          >
            {a.name}
          </b>
          {isAgent && (
            <span
              data-agent-tag=""
              className="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-1.5 text-[length:var(--oa-text-xs)] text-foreground"
            >
              agent
            </span>
          )}
          <span
            className={`${MUTED} shrink-0 whitespace-nowrap ${TXT} ${hideTime ? "sr-only" : ""}`}
            title={exactDate(at)}
          >
            {versionDate(at)}
            {edited && " · edited"}
          </span>
        </p>
        {/* #1789/#1822: product (or "not linked") and "for <person>" on a muted line. */}
        <AuthorSub a={a} />
      </div>
    </div>
  );
}

function CommentRow({
  api,
  thread,
  c,
  root,
  allProblems,
  askQuestion,
}: {
  api: CommentsApi;
  thread: CommentThread;
  c: CommentT;
  root: boolean;
  /** The thread's new delivery problems per comment, computed once in ThreadCard. */
  allProblems: ReturnType<typeof newProblems>;
  /** Open a question to the agent that asked (#1794). */
  askQuestion?: () => void;
}) {
  const nextAsk = nextAskFor(api, thread.id);
  const errCtx = useCommentErrorCtx();
  const edit = useEditComment(api.artifactId, api.guest);
  const del = useDeleteComment(api.artifactId, api.guest);
  const [menu, setMenu] = useState(false);
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  const [delError, setDelError] = useState<unknown>(null);
  const any = c.can.edit || c.can.delete;
  // #2229: marks sit on people's comments, for members (#2004: not guests, nor the capped); an agent's own reply has none.
  const marks = !api.guest && !api.capped && c.author.kind !== "agent";
  const problems = allProblems.get(c.id);
  const tight = useTightHeader(marks && !!c.notified?.length);
  return (
    <li
      className="flex flex-col gap-1"
      data-comment={c.id}
      data-live={api.live.tint.has(c.id) ? "" : undefined}
    >
      <div
        ref={tight.ref}
        data-header-stage={tight.stage}
        className="flex items-start justify-between gap-2"
      >
        <Who
          a={c.author}
          at={c.createdAt}
          edited={c.editedAt !== null}
          hideTime={tight.stage >= 1}
        />
        <div className="flex shrink-0 items-center gap-1">
          {marks && c.notified?.length ? (
            <DeliveryFaces told={c.notified} compact={tight.stage >= 2} />
          ) : null}
          {any && mode === "view" && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Comment actions"
              aria-expanded={menu}
              onClick={() => setMenu((m) => !m)}
            >
              •••
            </Button>
          )}
        </div>
      </div>
      {/* #2118: the face hangs in its own column; the text lines up with the name. */}
      <div className="flex flex-col gap-1 pl-8" data-comment-body="">
        {menu && mode === "view" && (
          <div className="flex gap-2">
            {c.can.edit && (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setMode("edit");
                  setMenu(false);
                }}
              >
                Edit
              </Button>
            )}
            {c.can.delete && (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setMode("delete");
                  setMenu(false);
                }}
              >
                Delete
              </Button>
            )}
          </div>
        )}
        {mode === "edit" ? (
          <Composer
            label="Edit comment"
            actions={ACTIONS_PLAIN}
            placeholder="Edit comment"
            submit="Save"
            initial={c.body}
            autoFocus
            onCancel={() => setMode("view")}
            onSubmit={async (body) => {
              await edit.mutateAsync({
                thread: thread.id,
                comment: c.id,
                body,
              });
              setMode("view");
            }}
          />
        ) : c.ask ? (
          <AskBlock
            artifactId={api.artifactId}
            thread={thread}
            c={c}
            next={nextAsk ? () => api.reveal(nextAsk) : undefined}
            reply={
              api.canComment ? () => api.select(thread.id, true) : undefined
            }
            askQuestion={askQuestion}
            guest={api.guest}
          />
        ) : (
          <p className={`whitespace-pre-wrap break-words ${CTXT}`}>
            <MentionedText
              body={c.body}
              mentions={c.mentions}
              guest={api.guest}
              marks={marks}
            />
          </p>
        )}
        <Delivery
          c={c}
          guest={api.guest}
          problems={api.guest ? [] : (problems ?? [])}
        />
        {mode === "delete" && (
          <div
            role="alertdialog"
            aria-label="Delete"
            className="flex flex-col gap-2"
          >
            <p className={TXT}>
              {root
                ? "Delete this thread? Its replies go too."
                : "Delete this reply?"}
            </p>
            {delError != null && (
              <p role="alert" className={`${TXT} text-destructive`}>
                {commentError(delError, api.capped, errCtx)}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                size="xs"
                variant="destructive"
                disabled={del.isPending}
                onClick={() => {
                  setDelError(null);
                  del.mutate(
                    { thread: thread.id, comment: c.id },
                    { onError: setDelError },
                  );
                }}
              >
                Delete
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setMode("view")}>
                Keep
              </Button>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

/** What the card says about where its quote went (from the frame's state). */
function Quote({ t, api }: { t: CommentThread; api: CommentsApi }) {
  const isAsk = !!t.comments[0]?.ask;
  const a = t.anchor;
  const state = api.positions.get(t.id)?.state;
  if (a.kind === "note")
    return (
      <p className={`flex items-center gap-1 ${TXT} font-medium ${MUTED}`}>
        <FileText aria-hidden="true" className="size-3.5 shrink-0" />
        Whole page
      </p>
    );
  if (a.kind === "pin") {
    const n = pinNumbering(api.threads).get(t.id) ?? 1;
    // Only when both hashes are known and differ (a pdf's hash covers the whole file, so the note says file).
    const changed = pinChanged(a.contentHash, api.contentHash);
    return (
      <div className="flex flex-col gap-1">
        <p className={`${TXT} font-medium ${MUTED}`}>
          {a.page ? `Page ${a.page} · ` : ""}Pin {n}
        </p>
        {changed && api.pinFormat && (
          <p className={`${TXT} ${MUTED}`}>
            {api.pinFormat === "image"
              ? "The image changed since this was placed."
              : "This file changed since this was placed."}
          </p>
        )}
      </div>
    );
  }
  const where = a.block?.page
    ? `Page ${a.block.page}`
    : a.block?.line
      ? `Line ${a.block.line}`
      : null;
  const original =
    state === "partial" || state === "collapsed" || state === "orphan";
  return (
    <div className="flex flex-col gap-1">
      {where && <p className={`${TXT} ${MUTED}`}>{where}</p>}
      {state === "partial" && (
        <p className={`${TXT} ${MUTED}`}>
          Text changed since this {isAsk ? "ask" : "comment"}
        </p>
      )}
      <QuoteBar>
        {original ? "Original text: " : ""}
        {original ? `“${a.exact}”` : a.exact}
      </QuoteBar>
    </div>
  );
}

function ThreadCard({ t, api }: { t: CommentThread; api: CommentsApi }) {
  const isActive = api.active === t.id;
  const reply = useReply(api.artifactId, api.guest);
  // The agent a question goes to, kept while the box is open so a pick
  // elsewhere doesn't swap the draft away (the server then says why).
  const [asking, setAsking] = useState<string | null>(null);
  const status = useSetThreadStatus(api.artifactId, api.guest);
  const errCtx = useCommentErrorCtx();
  const [statusErr, setStatusErr] = useState<unknown>(null);
  const el = useRef<HTMLLIElement>(null);
  const navigate = useNavigate();
  const resolved = t.status === "resolved";
  const [first, ...rest] = t.comments;
  const allProblems = useMemo(() => newProblems(t.comments), [t.comments]);
  const expanded = isActive || rest.length === 0;
  // #2179: a folded thread keeps its first comment and its latest reply in
  // view, and nothing the reader saw folds away mid-visit: the latest reply on
  // load and every reply since stay (api.live.kept). Only replies folded at
  // load stay behind the button.
  // A fold hides two replies or more: never "Show 1 earlier reply".
  const last = rest[rest.length - 1];
  const kept = rest.filter((c) => c === last || api.live.kept.has(c.id));
  const shown = expanded || rest.length - kept.length < 2 ? rest : kept;
  const hidden = rest.length - shown.length;
  const orphan = api.positions.get(t.id)?.state === "orphan";
  const revealTick = api.revealed.tick;
  const revealedHere = api.revealed.id === t.id;
  // Runs on mount too, so a column that is just opening still scrolls and focuses.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revealTick re-fires it for an already-active card.
  useEffect(() => {
    if (!isActive) return;
    el.current?.scrollIntoView?.({ block: "nearest" });
    // #1783: in the short pin sheet a thread with 2+ replies shows its last
    // reply just above the floating action row, not the card's top.
    const card = el.current;
    const last =
      t.comments.length > 2 ? t.comments[t.comments.length - 1] : null;
    let frame = 0;
    let watch: ResizeObserver | undefined;
    // Only where the sheet owns a floating row (its outlet exists): the wide
    // overlay at pin height has none and does not scroll.
    const outlet = card
      ?.closest('[data-sheet-height="pin"]')
      ?.querySelector<HTMLElement>("[data-oa-action-outlet]");
    if (card && last && outlet) {
      const go = () => {
        // Hidden (not claimed yet) or gone (the sheet grew for typing): wait
        // for a real measure, never scroll on 0.
        if (!outlet.isConnected || outlet.offsetHeight === 0) return;
        const reply = card.querySelector<HTMLElement>(
          `[data-comment="${last.id}"]`,
        );
        if (!reply) return;
        // The row's own height, which already includes the safe-area inset.
        // The composer claims the outlet after this effect, so the height
        // changes from 0 once it shows: the observer re-measures and scrolls.
        reply.style.scrollMarginBottom = `${outlet.offsetHeight}px`;
        // One measure is enough: later size changes (typing) don't re-scroll.
        watch?.disconnect();
        const reduce =
          window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ===
          true;
        reply.scrollIntoView?.({
          block: "end",
          behavior: reduce ? "auto" : "smooth",
        });
      };
      frame = requestAnimationFrame(go);
      if (typeof ResizeObserver !== "undefined") {
        watch = new ResizeObserver(go);
        watch.observe(outlet);
      }
    }
    if (revealedHere && revealTick > api.revealDone.current) {
      api.revealDone.current = revealTick;
      el.current?.focus({ preventScroll: true });
    }
    return () => {
      cancelAnimationFrame(frame);
      watch?.disconnect();
    };
  }, [isActive, revealTick]);
  // #2179: "Show N earlier replies" moves focus to the first reply it
  // revealed (after the effect above, which may focus the card).
  const [revealFirst, setRevealFirst] = useState<string | null>(null);
  useEffect(() => {
    if (!revealFirst || !expanded) return;
    const r = el.current?.querySelector<HTMLElement>(
      `[data-comment="${CSS.escape(revealFirst)}"]`,
    );
    setRevealFirst(null);
    if (r) focusRow(r);
  }, [revealFirst, expanded]);
  // Leaving the thread drops the question mode.
  useEffect(() => {
    if (!isActive) setAsking(null);
  }, [isActive]);
  if (!first) return null;
  // "Ask a question" (#1794): an open, unanswered ask from an agent, to someone who may reply.
  const asker =
    first.ask &&
    first.author.kind === "agent" &&
    !first.ask.answer &&
    !first.ask.closed &&
    api.canComment
      ? first.author.name
      : null;
  const toggle = () => {
    setStatusErr(null);
    status.mutate(
      { thread: t.id, status: resolved ? "open" : "resolved" },
      { onError: setStatusErr },
    );
  };
  return (
    <li
      ref={el}
      data-thread={t.id}
      data-active={isActive ? "" : undefined}
      tabIndex={-1}
      className="rounded-lg border focus-visible:outline-2 focus-visible:outline-[var(--oa-focus)] border-border bg-card p-3 data-[active]:border-ring data-[active]:ring-1 data-[active]:ring-ring"
    >
      <div className="flex flex-col gap-2">
        <button
          type="button"
          className="cursor-pointer border-0 bg-transparent p-0 text-left"
          aria-label={
            t.anchor.kind === "pin"
              ? `Show pin ${pinNumbering(api.threads).get(t.id) ?? 1} in page`
              : `Show in page: ${t.anchor.kind === "text" ? t.anchor.exact : "comment"}`
          }
          aria-pressed={isActive}
          onClick={() => api.select(t.id, true)}
        >
          <Quote t={t} api={api} />
        </button>
        {orphan && (
          <p className={`${TXT} ${MUTED}`}>
            Made on version {t.version}.{" "}
            <a
              href={viewerPath(api.artifactId, t.version)}
              onClick={(e) => {
                e.preventDefault();
                void navigate({
                  to: viewerPath(api.artifactId, t.version) as string,
                });
              }}
            >
              See version {t.version}
            </a>
          </p>
        )}
        {resolved && (
          <p
            data-resolved-line=""
            className={`flex items-center gap-1 ${TXT} text-green-700 dark:text-green-400`}
          >
            <Check aria-hidden="true" className="size-3.5 shrink-0" />
            Resolved by{" "}
            {t.resolvedBy ? actor(t.resolvedBy, t.resolvedBy.name) : "someone"}
            {t.resolvedAt ? ` · ${versionDate(t.resolvedAt)}` : ""}
          </p>
        )}
        {/* The fold button sits between two lists, not inside one. */}
        <div className="flex flex-col gap-3">
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            <CommentRow
              api={api}
              thread={t}
              c={first}
              allProblems={allProblems}
              root
              askQuestion={
                asker && !asking
                  ? () => {
                      setAsking(asker);
                      api.select(t.id, true);
                    }
                  : undefined
              }
            />
          </ul>
          {hidden > 0 && (
            <Button
              size="xs"
              variant="ghost"
              data-earlier=""
              className="-my-1.5 ml-8 h-auto min-h-6 self-start px-0 py-1.5 max-sm:-my-2.5 max-sm:min-h-8 max-sm:py-2.5"
              onClick={() => {
                // The thread keeps its top: the revealed replies open below
                // it, not above the reader.
                holdAnchor(el.current);
                setRevealFirst(rest[0]?.id ?? null);
                api.select(t.id, true);
              }}
            >
              {`Show ${hidden} earlier replies`}
            </Button>
          )}
          {shown.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {shown.map((c) => (
                <CommentRow
                  key={c.id}
                  api={api}
                  thread={t}
                  c={c}
                  allProblems={allProblems}
                  root={false}
                />
              ))}
            </ul>
          )}
        </div>
        {statusErr != null && (
          <p role="alert" className={`${TXT} text-destructive`}>
            {commentError(statusErr, api.capped, errCtx)}
          </p>
        )}
        {asking && isActive ? (
          <>
            {api.guest && <GuestName api={api} />}
            <Composer
              key="ask"
              label="Question"
              actions={ACTIONS_PLAIN}
              placeholder={`Ask ${asking} a question`}
              submit="Send"
              autoFocus
              buttonsRight
              onCancel={() => setAsking(null)}
              lead={
                <span className={`${TXT} ${MUTED}`} data-to-asker="">
                  To {asking}, the agent that asked
                </span>
              }
              onSubmit={async (body) => {
                await reply.mutateAsync({
                  thread: t.id,
                  body,
                  toAsker: true,
                  ...(api.guest ? { guestName: api.guestName.trim() } : {}),
                });
                setAsking(null);
              }}
            />
          </>
        ) : api.canComment && isActive ? (
          <>
            {api.guest && <GuestName api={api} />}
            {!api.guest && !api.capped && <ThreadAgents t={t} api={api} />}
            <Composer
              label="Reply"
              actions={ACTIONS_PLAIN}
              placeholder="Reply"
              mentionPlaceholder="Reply. Type @ to mention an agent."
              submit="Reply"
              mentionable
              float
              onSubmit={(body, x) =>
                reply.mutateAsync({
                  thread: t.id,
                  body,
                  ...extrasBody(x),
                  ...(api.guest ? { guestName: api.guestName.trim() } : {}),
                })
              }
              extra={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={status.isPending}
                  onClick={toggle}
                >
                  {resolved ? "Reopen" : "Resolve"}
                </Button>
              }
            />
          </>
        ) : (
          api.canComment && (
            <div className="flex gap-2 pl-8">
              <Button
                size="xs"
                variant="outline"
                onClick={() => api.select(t.id, true)}
              >
                Reply
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={status.isPending}
                onClick={toggle}
              >
                {resolved ? "Reopen" : "Resolve"}
              </Button>
            </div>
          )
        )}
      </div>
    </li>
  );
}

function NewThread({ api }: { api: CommentsApi }) {
  const create = useCreateThread(api.artifactId, api.guest);
  const last = useRef("");
  const draft = api.draft;
  if (!draft) return null;
  const guest = api.guest ? { guestName: api.guestName.trim() } : {};
  return (
    <div className="flex flex-col gap-2" data-oa-composing="">
      {api.older && (
        <p className={`${TXT} ${MUTED}`}>
          You're commenting on version {api.version}.
        </p>
      )}
      <GuestName api={api} />
      <Composer
        label="Add a comment"
        placeholder="Add a comment"
        mentionPlaceholder="Add a comment. Type @ to mention an agent."
        submit="Comment"
        autoFocus
        buttonsRight
        card
        actions={ACTIONS_PLAIN}
        quote={
          "pin" in draft ? (
            <p className={`${TXT} font-medium ${MUTED}`}>
              {draft.pin.page ? `Page ${draft.pin.page} · ` : ""}New pin
            </p>
          ) : (
            <QuoteBar>{draft.anchor.exact}</QuoteBar>
          )
        }
        lead={api.guest ? <SignInLink /> : undefined}
        mentionable
        onDirty={api.setDraftDirty}
        onCancel={api.cancelDraft}
        onSubmit={async (body, x) => {
          last.current = body;
          await create.mutateAsync({
            anchor:
              "pin" in draft
                ? { kind: "pin", version: api.version, ...draft.pin }
                : { ...draft.anchor, kind: "text", version: api.version },
            body,
            ...extrasBody(x),
            ...guest,
          });
          // Posted: keep the quote painted until the list carries the thread
          // (#1834), so the draft highlight becomes the thread's, no gap.
          api.cancelDraft(true);
        }}
        failure={(e) =>
          e instanceof ApiClientError && e.code === "anchor_not_in_version" ? (
            <>
              {" "}
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent p-0 underline"
                onClick={() =>
                  void create
                    .mutateAsync({
                      anchor: { kind: "note" },
                      body: last.current,
                      ...guest,
                    })
                    .then(
                      () => api.cancelDraft(true),
                      () => {},
                    )
                }
              >
                Add as a page note
              </button>
            </>
          ) : null
        }
      />
    </div>
  );
}

function NoteComposer({ api }: { api: CommentsApi }) {
  const create = useCreateThread(api.artifactId, api.guest);
  return (
    <div className="flex flex-col gap-2">
      {api.guest && <GuestName api={api} />}
      <Composer
        label="Comment on the whole page"
        placeholder="Comment on the whole page"
        mentionPlaceholder="Add a comment. Type @ to mention an agent."
        submit="Comment"
        buttonsRight
        card
        keepOnEsc
        actions={ACTIONS_PLAIN}
        lead={api.guest ? <SignInLink /> : undefined}
        mentionable
        onSubmit={(body, x) =>
          create.mutateAsync({
            anchor: { kind: "note" },
            body,
            ...extrasBody(x),
            ...(api.guest ? { guestName: api.guestName.trim() } : {}),
          })
        }
      />
    </div>
  );
}

/** Amber "N asks for you" button: steps to the next unanswered ask. */
function AsksForYou({
  count,
  onClick,
}: {
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-asks-for-you
      className="cursor-pointer rounded-sm border-0 bg-[var(--oa-warning-soft)] px-2 py-0.5 font-semibold text-[var(--oa-warning)] shadow-[inset_0_0_0_1px_var(--oa-warning)] focus-visible:outline-2 focus-visible:outline-[var(--oa-focus)]"
    >
      {count} ask{count === 1 ? "" : "s"} for you
    </button>
  );
}

/** The list, header and composers: one body for the column, panel tab and sheet. */
export function CommentsBody({
  textFormat = true,
  /** Grow to fill the surface. Off in the phone sheet's short height, where the
      action row's outlet follows the list as a sibling (#1711). */
  grow = true,
  /** The phone sheet's short height, kept for reading one pinned card (#1783). */
  short = false,
  /** The "Comments" heading with the open count; the phone sheet has its own row. */
  heading = true,
}: {
  heading?: boolean;
  textFormat?: boolean;
  grow?: boolean;
  short?: boolean;
}) {
  const api = useCommentsApi();
  const resolvedCount = api.threads.filter(
    (t) => t.status === "resolved",
  ).length;
  const visible = (ts: readonly CommentThread[]) =>
    ts.filter((t) => api.showResolved || t.status === "open");
  const ordered = visible(api.ordered);
  const orphans = visible(api.orphans);
  const none = api.threads.length === 0;
  const forMe = asksForMe([...api.ordered, ...api.orphans]);
  // #2118: one composer at a time: a quote open hides the whole-page box
  // (mounted still, so a typed note survives) until Cancel or send.
  const draftOpen = api.draft != null && api.canComment;
  const box = useRef<HTMLDivElement>(null);
  const keep = useKeepScroll(box, api.live.arrived);
  return (
    // #1711: in the short sheet the list keeps its content height (`flex-none`:
    // no grow, no shrink, no zero basis), so the action row's outlet sits after
    // it, stuck to the sheet's bottom, instead of riding up to the sheet's top
    // when a card is scrolled into view. Every other surface grows as before.
    <div
      ref={box}
      className={`flex ${grow ? "min-h-fit flex-1" : "min-h-0 flex-none"} flex-col gap-3 p-4 [overflow-anchor:none]`}
      style={
        { "--oa-live-tint-ms": `${LIVE_TINT_MS}ms` } as React.CSSProperties
      }
    >
      {keep.pill === "up" && (
        <NewReplyPill dir="up" onClick={keep.go} under={heading} />
      )}
      {/* #2179: one polite message per refetch that brought replies. The
          region stays mounted; a zero-width space alternates so the same
          words twice are still a change. */}
      <p data-live-region="" className="sr-only" aria-live="polite">
        {api.live.announce.text}
        {api.live.announce.n % 2 ? "\u200b" : ""}
      </p>
      {heading && (
        <div
          data-comments-header=""
          className="sticky top-0 z-20 -mx-4 -mt-4 flex items-baseline justify-between gap-2 bg-[var(--oa-bg)] px-4 pt-4 pb-2"
        >
          <h2 className={`m-0 font-semibold ${CTXT}`}>Comments</h2>
          {api.listedOpen > 0 && (
            <span className={`${TXT} ${MUTED}`}>{api.listedOpen} open</span>
          )}
        </div>
      )}
      {(forMe.length > 0 || resolvedCount > 0) && (
        <div className={`flex items-center justify-between gap-2 ${TXT}`}>
          {forMe.length > 0 ? (
            <AsksForYou
              count={forMe.length}
              onClick={() => {
                const id = nextAskFor(api, api.active, { includeSelf: true });
                if (id) api.reveal(id);
              }}
            />
          ) : (
            <span />
          )}
          {resolvedCount > 0 && (
            <button
              type="button"
              aria-pressed={api.showResolved}
              className={`-my-1.5 min-h-6 cursor-pointer border-0 bg-transparent px-0 py-1.5 underline max-sm:-my-2.5 max-sm:min-h-8 max-sm:py-2.5 underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-[var(--oa-focus)] ${MUTED}`}
              onClick={() => api.setShowResolved(!api.showResolved)}
            >
              {api.showResolved
                ? "Hide resolved"
                : `Show resolved (${resolvedCount})`}
            </button>
          )}
        </div>
      )}
      <Tools api={api} />
      {api.draft && api.canComment && (
        <NewThread
          key={JSON.stringify(
            "pin" in api.draft ? api.draft.pin : api.draft.anchor,
          )}
          api={api}
        />
      )}
      {/* #1783: the short sheet is for the pinned card, so the whole-page box
          is not shown there. Hidden with CSS, never unmounted: a typed draft has
          to survive a pin tap, and dragging the sheet up brings the box back. */}
      <div
        hidden={draftOpen}
        className={short || draftOpen ? "hidden" : "contents"}
      >
        {api.canComment ? (
          <NoteComposer api={api} />
        ) : (
          api.guest && <SignInLink box />
        )}
      </div>
      {api.error != null && !api.threads.length ? (
        <div role="alert" className={`flex flex-col gap-2 ${TXT}`}>
          <p>Couldn't load comments.</p>
          <Button
            size="xs"
            variant="outline"
            className="self-start"
            onClick={api.refetch}
          >
            Retry
          </Button>
        </div>
      ) : api.loading ? (
        <p className={`${TXT} ${MUTED}`} aria-busy="true">
          Loading comments…
        </p>
      ) : none ? (
        <p className={`${TXT} ${MUTED}`}>
          {api.pinFormat === "image" && api.canComment
            ? "No comments yet. Place a pin to add one."
            : textFormat && api.canComment
              ? "No comments yet. Select text to add one."
              : "No comments yet."}
        </p>
      ) : (
        <>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {ordered.map((t) => (
              <ThreadCard key={t.id} t={t} api={api} />
            ))}
          </ul>
          {orphans.length > 0 && (
            <section
              aria-labelledby="oa-orphans"
              className="flex flex-col gap-3"
            >
              <h3 id="oa-orphans" className={`${TXT} font-medium`}>
                On earlier text
              </h3>
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {orphans.map((t) => (
                  <ThreadCard key={t.id} t={t} api={api} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      {keep.pill === "down" && (
        <NewReplyPill
          dir="down"
          foot={keep.foot}
          onClick={keep.go}
          under={heading}
        />
      )}
    </div>
  );
}
