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
import { Check, FileText, Quote as QuoteIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiClientError } from "../../api/client";
import {
  commentError,
  TooManyMentions,
  useArtifactAgents,
  useCreateThread,
  useDeleteComment,
  useEditComment,
  useReply,
  useSetThreadStatus,
} from "../../api/comments";
import { isEmbed } from "../../embed";
import { TXT } from "../ui";
import { exactDate, versionDate } from "../versionDate";
import { useActionRowSlot } from "./actionRow";
import {
  AskBlock,
  asksForMe,
  Delivery,
  type Extras,
  extrasBody,
  MentionMenu,
  matchAgents,
  mentionedKeys,
  mentionQuery,
} from "./asks";
import { numbering, pinChanged, pinNumbering } from "./model";
import { type CommentsApi, useCommentsApi } from "./useComments";

const touch = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(pointer: coarse)").matches === true;

/** "Click to place a pin" on a pointer device, "Tap to place a pin" on touch. */
export const pinHint = () =>
  touch() ? "Tap to place a pin" : "Click to place a pin";

/** "Esc to cancel", on a device with a keyboard only: touch has the Select button. */
function EscHint() {
  return touch() ? null : <span> · Esc to cancel</span>;
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
          <EscHint />
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
        <EscHint />
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

/** A guest's way to sign in, back to this page. */
function SignInLink() {
  return (
    <a
      className={`${TXT} text-[var(--oa-accent-fg)] underline`}
      href={`/sign-in?next=${encodeURIComponent(
        `${window.location.pathname}${window.location.search}`,
      )}`}
      target={isEmbed() ? "_blank" : undefined}
      rel="noopener noreferrer"
    >
      Sign in
    </a>
  );
}

/** A box with its buttons; `onSubmit` rejects with the failure to show. */
function Composer({
  placeholder,
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
}: {
  /** Offer @mentions and Assign: the agent list is fetched once an "@" is typed. */
  mentionable?: boolean;
  /** The action row's own surface while it floats in the short sheet (#1657). */
  actions?: string;
  /** Let the sheet's outlet take the row while it is short (#1711). */
  float?: boolean;
  /** The new-comment layout: Assign on its own line, then Cancel and the
      accent submit at the right. */
  buttonsRight?: boolean;
  /** Shown at the left of the button row (a guest's Sign in link). */
  lead?: React.ReactNode;
  /** Called when the box gains or loses text the reader typed. */
  onDirty?: (dirty: boolean) => void;
  placeholder: string;
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
  const [text, setText] = useState(initial);
  const [open, setOpen] = useState(alwaysOpen);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const once = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [assign, setAssign] = useState("");
  const [menuOff, setMenuOff] = useState(false);
  const [activeOpt, setActiveOpt] = useState(0);
  const menuId = useId();
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
  const pick = (a: ArtifactAgent) => {
    const before = text.slice(0, caret).replace(/@[\w .-]{0,40}$/, "");
    setText(`${before}@${a.name} ${text.slice(caret)}`);
    const at = before.length + a.name.length + 2;
    setCaret(at);
    setMenuOff(true);
    setActiveOpt(0);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(at, at);
    });
  };
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
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
        ...(assign ? { assign: { key: assign } } : {}),
      });
      setText("");
      setAssign("");
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
      className="flex flex-col gap-2"
      data-oa-composing={composing ? "" : undefined}
    >
      <Textarea
        ref={ref}
        aria-label={label}
        placeholder={placeholder}
        value={text}
        maxLength={COMMENT_BODY_MAX}
        rows={open ? 3 : 1}
        className={TXT}
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
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void go();
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
          active={activeOpt}
          onPick={pick}
        />
      )}
      {error != null && (
        <p role="alert" className={`${TXT} text-destructive`}>
          {commentError(error, capped)}
          {failure?.(error)}
        </p>
      )}
      {open &&
        (() => {
          const assignSel = agents && agents.length > 0 && (
            <label
              className={`flex items-center gap-1 ${TXT} ${buttonsRight ? "w-full" : ""}`}
            >
              Assign to
              <select
                className={`min-w-0 rounded-md border border-input bg-background px-1 py-0.5 ${TXT}`}
                value={assign}
                onChange={(e) => setAssign(e.target.value)}
              >
                <option value="">No one</option>
                {agents.map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          );
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
              {assignSel}
              <div className="flex flex-wrap items-center gap-2">
                {lead}
                <div className="ml-auto flex items-center gap-2">
                  {extra}
                  {cancelBtn}
                  <Button
                    size="xs"
                    className="bg-[var(--oa-accent)] text-[var(--oa-accent-text)] hover:bg-[var(--oa-accent-fg)]"
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
              {assignSel}
              {cancelBtn}
            </div>
          );
          return slot ? createPortal(row, slot) : row;
        })()}
    </div>
  );
}

/** Up to two initials of a display name. */
export function initials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  const first = (x?: string) => Array.from(x ?? "")[0] ?? "";
  const out =
    w.length > 1
      ? `${first(w[0])}${first(w[w.length - 1])}`
      : Array.from(w[0] ?? "?")
          .slice(0, 2)
          .join("");
  return out.toUpperCase();
}

function Who({
  a,
  at,
  edited,
}: {
  a: CommentAuthor;
  at: string;
  edited: boolean;
}) {
  const via = a.agent
    ? a.agent.startsWith("via ")
      ? a.agent
      : `via ${a.agent}`
    : null;
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span
        aria-hidden="true"
        data-avatar=""
        className={`flex size-6 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-[length:var(--oa-text-xs)] font-medium text-foreground`}
      >
        {initials(a.name)}
      </span>
      <p
        className={`m-0 flex min-w-0 items-baseline gap-x-1 self-center ${TXT}`}
      >
        <b className="min-w-0 truncate" title={a.name}>
          {a.name}
        </b>
        {via && (
          <span
            data-via=""
            className={`${MUTED} min-w-0 truncate text-[length:var(--oa-text-xs)]`}
          >
            {via}
          </span>
        )}
        <span
          className={`${MUTED} shrink-0 whitespace-nowrap`}
          title={exactDate(at)}
        >
          {versionDate(at)}
          {edited && " · edited"}
        </span>
      </p>
    </div>
  );
}

function CommentRow({
  api,
  thread,
  c,
  root,
}: {
  api: CommentsApi;
  thread: CommentThread;
  c: CommentT;
  root: boolean;
}) {
  const pending = asksForMe([...api.ordered, ...api.orphans]).filter(
    (id) => id !== thread.id,
  );
  const nextAsk = pending[0];
  const edit = useEditComment(api.artifactId, api.guest);
  const del = useDeleteComment(api.artifactId, api.guest);
  const [menu, setMenu] = useState(false);
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  const [delError, setDelError] = useState<unknown>(null);
  const any = c.can.edit || c.can.delete;
  return (
    <li className="flex flex-col gap-1" data-comment={c.id}>
      <div className="flex items-start justify-between gap-2">
        <Who a={c.author} at={c.createdAt} edited={c.editedAt !== null} />
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
          placeholder="Edit comment"
          submit="Save"
          initial={c.body}
          autoFocus
          onCancel={() => setMode("view")}
          onSubmit={async (body) => {
            await edit.mutateAsync({ thread: thread.id, comment: c.id, body });
            setMode("view");
          }}
        />
      ) : c.ask ? (
        <AskBlock
          artifactId={api.artifactId}
          thread={thread}
          c={c}
          next={nextAsk ? () => api.select(nextAsk, true) : undefined}
        />
      ) : (
        <p className={`whitespace-pre-wrap break-words ${TXT}`}>{c.body}</p>
      )}
      <Delivery c={c} />
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
              {commentError(delError, api.capped)}
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
    </li>
  );
}

/** What the card says about where its quote went (from the frame's state). */
function Quote({ t, api }: { t: CommentThread; api: CommentsApi }) {
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
        <p className={`${TXT} ${MUTED}`}>Text changed since this comment</p>
      )}
      <blockquote
        className={`flex items-start gap-1.5 border-0 border-l-2 border-l-border pl-2 ${TXT} ${MUTED}`}
      >
        <QuoteIcon
          aria-hidden="true"
          data-quote-chip=""
          className="mt-0.5 size-3.5 shrink-0"
        />
        <span className="line-clamp-3 min-w-0 break-words">
          {original ? "Original text: " : ""}
          {original ? `“${a.exact}”` : a.exact}
        </span>
      </blockquote>
    </div>
  );
}

function ThreadCard({ t, api }: { t: CommentThread; api: CommentsApi }) {
  const isActive = api.active === t.id;
  const reply = useReply(api.artifactId, api.guest);
  const status = useSetThreadStatus(api.artifactId, api.guest);
  const [statusErr, setStatusErr] = useState<unknown>(null);
  const el = useRef<HTMLLIElement>(null);
  const navigate = useNavigate();
  const resolved = t.status === "resolved";
  const [first, ...rest] = t.comments;
  const expanded = isActive || rest.length === 0;
  const shown = expanded ? rest : [];
  const orphan = api.positions.get(t.id)?.state === "orphan";
  useEffect(() => {
    if (isActive) el.current?.scrollIntoView?.({ block: "nearest" });
  }, [isActive]);
  if (!first) return null;
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
      className="rounded-lg border border-border bg-background p-3 data-[active]:border-ring data-[active]:ring-1 data-[active]:ring-ring"
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
            Resolved by {t.resolvedBy?.name ?? "someone"}
            {t.resolvedAt ? ` · ${versionDate(t.resolvedAt)}` : ""}
          </p>
        )}
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          <CommentRow api={api} thread={t} c={first} root />
          {shown.map((c) => (
            <CommentRow key={c.id} api={api} thread={t} c={c} root={false} />
          ))}
        </ul>
        {!expanded && (
          <Button
            size="xs"
            variant="ghost"
            className="self-start"
            onClick={() => api.select(t.id, true)}
          >
            {rest.length === 1 ? "1 reply" : `${rest.length} replies`}
          </Button>
        )}
        {statusErr != null && (
          <p role="alert" className={`${TXT} text-destructive`}>
            {commentError(statusErr, api.capped)}
          </p>
        )}
        {api.canComment && isActive ? (
          <>
            {api.guest && <GuestName api={api} />}
            <Composer
              label="Reply"
              placeholder="Reply"
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
            <div className="flex gap-2">
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
    <div
      className="flex flex-col gap-2 rounded-lg border border-ring bg-background p-3"
      data-oa-composing=""
    >
      {api.older && (
        <p className={`${TXT} ${MUTED}`}>
          You're commenting on version {api.version}.
        </p>
      )}
      {"pin" in draft ? (
        <p className={`${TXT} font-medium ${MUTED}`}>
          {draft.pin.page ? `Page ${draft.pin.page} · ` : ""}New pin
        </p>
      ) : (
        <blockquote
          className={`border-0 border-l-2 border-l-border pl-2 ${TXT} ${MUTED} line-clamp-3 break-words`}
        >
          {draft.anchor.exact}
        </blockquote>
      )}
      <GuestName api={api} />
      <Composer
        label="Add a comment"
        placeholder="Add a comment"
        submit="Comment"
        autoFocus
        buttonsRight
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
          api.cancelDraft();
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
                    .then(api.cancelDraft, () => {})
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
        submit="Comment"
        alwaysOpen={false}
        buttonsRight
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

/** The list, header and composers: one body for the column, panel tab and sheet. */
export function CommentsBody({
  textFormat = true,
  /** Grow to fill the surface. Off in the phone sheet's short height, where the
      action row's outlet follows the list as a sibling (#1711). */
  grow = true,
}: {
  textFormat?: boolean;
  grow?: boolean;
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
  return (
    // #1711: in the short sheet the list keeps its content height (`flex-none`:
    // no grow, no shrink, no zero basis), so the action row's outlet sits after
    // it, stuck to the sheet's bottom, instead of riding up to the sheet's top
    // when a card is scrolled into view. Every other surface grows as before.
    <div
      className={`flex min-h-0 ${grow ? "flex-1" : "flex-none"} flex-col gap-3 p-4`}
    >
      <div className={`flex items-center justify-between gap-2 ${TXT}`}>
        <span>
          {api.listedOpen} open
          {forMe.length > 0 &&
            ` · ${forMe.length} ask${forMe.length === 1 ? "" : "s"} for you`}
        </span>
        {resolvedCount > 0 && (
          <Button
            size="xs"
            variant="ghost"
            aria-pressed={api.showResolved}
            onClick={() => api.setShowResolved(!api.showResolved)}
          >
            {api.showResolved
              ? "Hide resolved"
              : `Show resolved (${resolvedCount})`}
          </Button>
        )}
      </div>
      <Tools api={api} />
      {api.draft && api.canComment && (
        <NewThread
          key={JSON.stringify(
            "pin" in api.draft ? api.draft.pin : api.draft.anchor,
          )}
          api={api}
        />
      )}
      {api.canComment ? (
        <NoteComposer api={api} />
      ) : (
        api.guest && <p className={`${TXT} ${MUTED}`}>Sign in to comment.</p>
      )}
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
    </div>
  );
}
