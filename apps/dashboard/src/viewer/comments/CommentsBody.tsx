import {
  COMMENT_BODY_MAX,
  COMMENT_GUEST_NAME_MAX,
  type CommentAuthor,
  type Comment as CommentT,
  type CommentThread,
  viewerPath,
} from "@oa/shared";
import { Button, Textarea } from "@oa/ui/shadcn";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ApiClientError } from "../../api/client";
import {
  commentError,
  useCreateThread,
  useDeleteComment,
  useEditComment,
  useReply,
  useSetThreadStatus,
} from "../../api/comments";
import { TXT } from "../ui";
import { exactDate, versionDate } from "../versionDate";
import { numbering } from "./model";
import { type CommentsApi, useCommentsApi } from "./useComments";

const MUTED = "text-muted-foreground";

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
}: {
  /** Called when the box gains or loses text the reader typed. */
  onDirty?: (dirty: boolean) => void;
  placeholder: string;
  label: string;
  submit: string;
  extra?: React.ReactNode;
  onSubmit: (body: string) => Promise<unknown>;
  onCancel?: () => void;
  initial?: string;
  autoFocus?: boolean;
  /** Collapsed to one line until focused. */
  alwaysOpen?: boolean;
  failure?: (e: unknown) => React.ReactNode;
}) {
  const { capped } = useCommentsApi();
  const [text, setText] = useState(initial);
  const [open, setOpen] = useState(alwaysOpen);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const once = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
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
      await onSubmit(body);
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
        onFocus={() => setOpen(true)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
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
      {error != null && (
        <p role="alert" className={`${TXT} text-destructive`}>
          {commentError(error, capped)}
          {failure?.(error)}
        </p>
      )}
      {open && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs" disabled={!body || busy} onClick={() => void go()}>
            {submit}
          </Button>
          {extra}
          {(onCancel || !alwaysOpen) && (
            <Button size="xs" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          )}
        </div>
      )}
    </div>
  );
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
  return (
    <div className="min-w-0">
      <p className={`flex min-w-0 items-baseline gap-x-1 ${TXT}`}>
        <b className="min-w-0 truncate" title={a.name}>
          {a.name}
        </b>
        <span
          className={`${MUTED} shrink-0 whitespace-nowrap`}
          title={exactDate(at)}
        >
          {versionDate(at)}
          {edited && " · edited"}
        </span>
      </p>
      {a.agent && (
        <p className={`${TXT} ${MUTED} break-words`}>
          {a.agent.startsWith("via ") ? a.agent : `via ${a.agent}`}
        </p>
      )}
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
      ) : (
        <p className={`whitespace-pre-wrap break-words ${TXT}`}>{c.body}</p>
      )}
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
    return <p className={`${TXT} font-medium ${MUTED}`}>Whole page</p>;
  if (a.kind === "pin") {
    const n = numbering(api.threads).get(t.id) ?? 1;
    return (
      <p className={`${TXT} font-medium ${MUTED}`}>
        {a.page ? `Page ${a.page} · ` : ""}Pin {n}
      </p>
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
        className={`border-0 border-l-2 border-l-border pl-2 ${TXT} ${MUTED} line-clamp-3 break-words`}
      >
        {original ? "Original text: " : ""}
        {original ? `“${a.exact}”` : a.exact}
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
          aria-label={`Show in page: ${t.anchor.kind === "text" ? t.anchor.exact : "comment"}`}
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
          <p className={`${TXT} ${MUTED}`}>
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
              onSubmit={(body) =>
                reply.mutateAsync({
                  thread: t.id,
                  body,
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
      <blockquote
        className={`border-0 border-l-2 border-l-border pl-2 ${TXT} ${MUTED} line-clamp-3 break-words`}
      >
        {draft.anchor.exact}
      </blockquote>
      <GuestName api={api} />
      <Composer
        label="Add a comment"
        placeholder="Add a comment"
        submit="Comment"
        autoFocus
        onDirty={api.setDraftDirty}
        onCancel={api.cancelDraft}
        onSubmit={async (body) => {
          last.current = body;
          await create.mutateAsync({
            anchor: { ...draft.anchor, kind: "text", version: api.version },
            body,
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
        onSubmit={(body) =>
          create.mutateAsync({
            anchor: { kind: "note" },
            body,
            ...(api.guest ? { guestName: api.guestName.trim() } : {}),
          })
        }
      />
    </div>
  );
}

/** The list, header and composers: one body for the column, panel tab and sheet. */
export function CommentsBody({ textFormat = true }: { textFormat?: boolean }) {
  const api = useCommentsApi();
  const resolvedCount = api.threads.filter(
    (t) => t.status === "resolved",
  ).length;
  const visible = (ts: readonly CommentThread[]) =>
    ts.filter((t) => api.showResolved || t.status === "open");
  const ordered = visible(api.ordered);
  const orphans = visible(api.orphans);
  const none = api.threads.length === 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className={`flex items-center justify-between gap-2 ${TXT}`}>
        <span>{api.listedOpen} open</span>
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
      {api.draft && api.canComment && (
        <NewThread key={JSON.stringify(api.draft.anchor)} api={api} />
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
          {textFormat && api.canComment
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
