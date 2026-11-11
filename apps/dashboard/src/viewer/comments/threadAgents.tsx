import type { CommentThread, ThreadAgent } from "@oa/shared";
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@oa/ui/shadcn";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  commentError,
  useCommentErrorCtx,
  useThreadAgent,
} from "../../api/comments";
import { TXT } from "../ui";
import { PartyFace } from "./AuthorFace";
import type { CommentsApi } from "./useComments";

const MUTED = "text-muted-foreground";
const GAP = 6;
const CHIP =
  "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-background pl-1 text-foreground";

/** What a chip says: face, name, and (when the caller may remove) the ×. */
const chipPad = (a: ThreadAgent) => (a.canRemove ? "pr-0.5" : "pr-2.5");

/** A tooltip on hover and focus (Radix wires aria-describedby). */
export function Tip({
  text,
  children,
  open,
  onOpenChange,
}: {
  text: string;
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
}) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip open={open} onOpenChange={onOpenChange}>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          side="top"
          collisionPadding={8}
          className="max-w-[260px]"
        >
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** A view-only chip: focusable, tooltip on hover, focus and tap. */
function ViewOnlyChip({ a }: { a: ThreadAgent }) {
  const [open, setOpen] = useState(false);
  return (
    <Tip
      open={open}
      onOpenChange={setOpen}
      text={`Only ${a.for ?? "the person"}, whose agent it is, or the artifact's owner can remove it.`}
    >
      <button
        type="button"
        data-thread-agent={a.key}
        className={`${CHIP} ${chipPad(a)} cursor-default font-[inherit]`}
        // A tap opens it (Radix opens on hover and focus only); the default is
        // kept from Radix's own click-to-close.
        onClick={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
      >
        <PartyFace p={a} />
        {a.name}
      </button>
    </Tip>
  );
}

/** The chip's content for measuring: the same box without any behaviour. */
const Ghost = ({ a }: { a: ThreadAgent }) => (
  <span className={`${CHIP} ${chipPad(a)}`}>
    <PartyFace p={a} />
    {a.name}
    {a.canRemove && <span className="inline-block size-[18px]" />}
  </span>
);

/**
 * How many chips fit on one line beside "Notifying" and the "+N" button.
 * Measures a hidden copy; at least one is always shown.
 */
function useFit(count: number, deps: string) {
  const row = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(count);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` names the chips measured
  useLayoutEffect(() => {
    const r = row.current;
    const g = ghost.current;
    if (!r || !g) return;
    const run = () => {
      const kids = [...g.children] as HTMLElement[];
      const label = kids[0]?.offsetWidth ?? 0;
      const plus = kids[1]?.offsetWidth ?? 0;
      const w = kids.slice(2).map((k) => k.offsetWidth);
      const room = r.clientWidth - label - GAP;
      let used = 0;
      let k = 0;
      for (let i = 0; i < w.length; i++) {
        const next = used + (w[i] ?? 0) + (i > 0 ? GAP : 0);
        const tail = i + 1 < w.length ? plus + GAP : 0;
        if (next + tail > room) break;
        used = next;
        k = i + 1;
      }
      setFit(Math.max(1, k));
    };
    run();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(run);
    ro.observe(r);
    return () => ro.disconnect();
  }, [count, deps]);
  return { row, ghost, fit };
}

/**
 * The removal flow shared by the "Notifying" chips and the participants list
 * (#2174): confirm, remove, "won't get replies" with Undo. One set of rules.
 */
export function useAgentRemoval(t: CommentThread, api: CommentsApi) {
  const set = useThreadAgent(api.artifactId, api.guest);
  const errCtx = useCommentErrorCtx();
  const [confirm, setConfirm] = useState<ThreadAgent | null>(null);
  const [gone, setGone] = useState<ThreadAgent | null>(null);
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
  return {
    set,
    errCtx,
    confirm,
    setConfirm,
    gone,
    err,
    agents,
    back,
    run,
  };
}

/** The confirm, the "won't get replies" line with Undo, and an error. */
export function RemovalNotices({
  rm,
  api,
}: {
  rm: ReturnType<typeof useAgentRemoval>;
  api: CommentsApi;
}) {
  const { set, errCtx, confirm, setConfirm, gone, err, back, run } = rm;
  return (
    <>
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
    </>
  );
}

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
  const rm = useAgentRemoval(t, api);
  const { setConfirm, gone, agents, back } = rm;
  const [all, setAll] = useState(false);
  const { row, ghost, fit } = useFit(
    agents.length,
    agents.map((x) => `${x.key}:${x.name}:${x.canRemove}`).join("|"),
  );
  if (agents.length === 0 && !gone) return null;
  const visible = all ? agents : agents.slice(0, fit);
  const more = agents.length - visible.length;
  return (
    <div
      data-thread-agents=""
      className={`flex flex-col gap-1 ${TXT} ${MUTED}`}
    >
      {agents.length > 0 && (
        <div
          ref={row}
          className={`relative flex items-center gap-1.5 ${
            all ? "flex-wrap" : "flex-nowrap overflow-hidden"
          }`}
        >
          <span className="shrink-0">Notifying</span>
          {visible.map((a) =>
            a.canRemove ? (
              <span
                key={a.key}
                data-thread-agent={a.key}
                className={`${CHIP} ${chipPad(a)}`}
              >
                <PartyFace p={a} />
                {a.name}
                <Tip text={`Stop notifying ${a.name} in this thread`}>
                  <button
                    type="button"
                    aria-label={`Stop notifying ${a.name}`}
                    className="inline-flex size-[18px] cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 leading-none text-muted-foreground hover:bg-muted hover:text-foreground"
                    onClick={(e) => {
                      back.current = e.currentTarget;
                      setConfirm(a);
                    }}
                  >
                    ×
                  </button>
                </Tip>
              </span>
            ) : (
              <ViewOnlyChip key={a.key} a={a} />
            ),
          )}
          {more > 0 && (
            <button
              type="button"
              aria-label={`Show ${more} more notified`}
              className="inline-flex h-6 shrink-0 cursor-pointer items-center rounded-full border-0 bg-[var(--oa-accent-soft)] px-2.5 text-[var(--oa-accent-fg)]"
              onClick={() => setAll(true)}
            >
              +{more}
            </button>
          )}
          <div
            ref={ghost}
            aria-hidden="true"
            className="pointer-events-none invisible absolute top-0 left-0 flex h-0 items-center gap-1.5 overflow-hidden whitespace-nowrap"
          >
            <span>Notifying</span>
            <span className="inline-flex h-6 px-2.5">+{agents.length}</span>
            {agents.map((a) => (
              <Ghost key={a.key} a={a} />
            ))}
          </div>
        </div>
      )}
      <RemovalNotices rm={rm} api={api} />
    </div>
  );
}
