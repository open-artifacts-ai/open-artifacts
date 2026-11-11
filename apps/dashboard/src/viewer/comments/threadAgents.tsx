import type { CommentThread, ThreadAgent } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useEffect, useRef, useState } from "react";
import {
  commentError,
  useCommentErrorCtx,
  useThreadAgent,
} from "../../api/comments";
import { TXT } from "../ui";
import { AuthorFace } from "./AuthorFace";
import type { CommentsApi } from "./useComments";

const MUTED = "text-muted-foreground";
/** Chips shown before "+N". */
const SHOWN = 2;

/**
 * #2035: "Notifying" and a chip for each agent the thread already tells on a
 * reply. The agent's person and the artifact's owner can take one out (after a
 * confirm); everyone else sees the chip with a tooltip that says who can.
 * Removal is for the whole thread and lasts until someone @-mentions the agent.
 */
export function ThreadAgents({
  t,
  api,
}: {
  t: CommentThread;
  api: CommentsApi;
}) {
  const set = useThreadAgent(api.artifactId, api.guest);
  const errCtx = useCommentErrorCtx();
  const [confirm, setConfirm] = useState<ThreadAgent | null>(null);
  const [gone, setGone] = useState<ThreadAgent | null>(null);
  const [all, setAll] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const back = useRef<HTMLButtonElement | null>(null);
  // The list refetches after a removal; until then the removed chip stays hidden.
  const agents = (t.agents ?? []).filter((x) => x.key !== gone?.key);
  // An @-mention puts the agent back: once the list has dropped it, seeing it again ends the note.
  const dropped = useRef(false);
  const listed = (t.agents ?? []).some((x) => x.key === gone?.key);
  useEffect(() => {
    if (!gone) {
      dropped.current = false;
      return;
    }
    if (!listed) dropped.current = true;
    else if (dropped.current) setGone(null);
  }, [listed, gone]);
  if (agents.length === 0 && !gone) return null;
  const visible = all ? agents : agents.slice(0, SHOWN);
  const more = agents.length - visible.length;
  const run = (a: ThreadAgent, removed: boolean) => {
    setErr(null);
    set.mutate(
      { thread: t.id, key: a.key, removed },
      {
        onSuccess: () => setGone(removed ? a : null),
        onError: setErr,
      },
    );
  };
  return (
    <div
      data-thread-agents=""
      className={`flex flex-col gap-1 ${TXT} ${MUTED}`}
    >
      {agents.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span>Notifying</span>
          {visible.map((a) => (
            <span
              key={a.key}
              data-thread-agent={a.key}
              title={
                a.canRemove
                  ? undefined
                  : `Only ${a.for ?? "the person"}, whose agent it is, or the artifact's owner can remove it.`
              }
              tabIndex={a.canRemove ? undefined : 0}
              className={`inline-flex h-6 items-center gap-1.5 rounded-full border border-border bg-background pl-1 text-foreground ${
                a.canRemove ? "pr-0.5" : "pr-2.5"
              }`}
            >
              <AuthorFace
                small
                a={{
                  kind: "agent",
                  name: a.name,
                  ...(a.linked !== undefined ? { linked: a.linked } : {}),
                  ...(a.product ? { product: a.product } : {}),
                  ...(a.animal ? { animal: a.animal } : {}),
                  me: false,
                }}
              />
              {a.name}
              {a.canRemove && (
                <button
                  type="button"
                  aria-label={`Stop notifying ${a.name}`}
                  title={`Stop notifying ${a.name} in this thread`}
                  className="inline-flex size-[18px] cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 leading-none text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={(e) => {
                    back.current = e.currentTarget;
                    setConfirm(a);
                  }}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {more > 0 && (
            <button
              type="button"
              aria-label={`Show ${more} more notified`}
              className="inline-flex h-6 cursor-pointer items-center rounded-full border-0 bg-[var(--oa-accent-soft)] px-2.5 text-[var(--oa-accent-fg)]"
              onClick={() => setAll(true)}
            >
              +{more}
            </button>
          )}
        </div>
      )}
      {confirm && (
        <section
          aria-label={`Remove ${confirm.name} from this thread`}
          data-thread-agent-confirm=""
          className="flex flex-col gap-2 rounded-lg border border-border bg-background p-2.5 text-foreground shadow-md"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setConfirm(null);
              back.current?.focus();
            }
          }}
        >
          <p className="m-0">
            Remove {confirm.name} from this thread? It won&apos;t get replies
            here until someone @-mentions it.
          </p>
          <div className="flex gap-1.5">
            <Button
              size="xs"
              variant="destructive"
              disabled={set.isPending}
              autoFocus
              onClick={() => {
                const a = confirm;
                setConfirm(null);
                run(a, true);
              }}
            >
              Remove
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setConfirm(null);
                back.current?.focus();
              }}
            >
              Keep
            </Button>
          </div>
        </section>
      )}
      {gone && (
        <p className="m-0" aria-live="polite" data-thread-agent-gone="">
          {gone.name} won&apos;t get replies in this thread.{" "}
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 text-[var(--oa-accent-fg)] underline"
            onClick={() => run(gone, false)}
          >
            Undo
          </button>
        </p>
      )}
      {err != null && (
        <p role="alert" className="m-0 text-destructive">
          {commentError(err, api.capped, errCtx)}
        </p>
      )}
    </div>
  );
}
