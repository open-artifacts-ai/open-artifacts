import type {
  ArtifactAgent,
  CommentAssigned,
  CommentMention,
  Comment as CommentT,
  CommentThread,
  KeyRef,
} from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useState } from "react";
import { answerError, useAnswerAsk } from "../../api/comments";
import { TXT } from "../ui";
import { versionDate } from "../versionDate";

const MUTED = "text-muted-foreground";

/** What the composer sends beyond the text. */
export type Extras = { mentions: KeyRef[]; assign?: KeyRef };

export const extrasBody = (x: Extras) => ({
  ...(x.mentions.length ? { mentions: x.mentions } : {}),
  ...(x.assign ? { assign: x.assign } : {}),
});

/** Open asks addressed to the viewer that nobody has answered, in the given order. */
export function asksForMe(threads: readonly CommentThread[]): string[] {
  return threads
    .filter((t) => t.status === "open")
    .filter((t) =>
      t.comments.some(
        (c) => c.ask && !c.ask.answer && c.ask.to.some((a) => a.me),
      ),
    )
    .map((t) => t.id);
}

const DELIVERY: Record<CommentMention["delivery"], string> = {
  delivered: "Delivered",
  queued: "offline · will get this when it's back",
  seen: "Seen",
  gone: "is gone. Mention another agent.",
};
const ASSIGNED: Record<CommentAssigned["state"], string> = {
  delivered: "Delivered",
  queued: "offline · will get this when it's back",
  seen: "Seen",
  done: "Done",
};

/** Delivery of each mention and the assignment, in plain words. Names are text, never HTML. */
export function Delivery({ c }: { c: CommentT }) {
  if (!c.mentions?.length && !c.assigned) return null;
  return (
    <ul className={`m-0 list-none p-0 ${TXT} ${MUTED}`}>
      {c.mentions?.map((m) => (
        <li key={m.key} data-mention={m.key}>
          <span className="font-medium">@{m.name}</span>{" "}
          {m.delivery === "gone" ? DELIVERY.gone : `· ${DELIVERY[m.delivery]}`}
        </li>
      ))}
      {c.assigned && (
        <li data-assigned={c.assigned.key}>
          Assigned to <span className="font-medium">{c.assigned.name}</span> ·{" "}
          {ASSIGNED[c.assigned.state]}
        </li>
      )}
    </ul>
  );
}

/** The ask on a comment: question, options, recommendation, and the answer buttons for those it is addressed to. */
export function AskBlock({
  artifactId,
  thread,
  c,
  next,
}: {
  artifactId: string;
  thread: CommentThread;
  c: CommentT;
  /** Jump to the next unanswered ask, when there is one. */
  next?: () => void;
}) {
  const ask = c.ask;
  const answer = useAnswerAsk(artifactId);
  const [err, setErr] = useState<unknown>(null);
  const [open, setOpen] = useState(false);
  if (!ask) return null;
  const mine = ask.to.some((a) => a.me);
  const canAnswer = mine && !ask.closed;
  const picked = ask.answer?.optionId;
  const pickedOpt = ask.options.find((o) => o.id === picked);
  // Decided and closed: one line, with a way to open it again.
  if (ask.closed && pickedOpt && !open)
    return (
      <div
        data-ask-decided=""
        className={`flex items-center gap-2 rounded-md bg-muted px-2 py-1 ${TXT}`}
      >
        <span className="min-w-0 flex-1 break-words">
          {ask.question}: {pickedOpt.label} · {ask.answer?.by.name}
        </span>
        <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
          Show
        </Button>
      </div>
    );
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border p-2"
      data-ask=""
    >
      <p className={`${TXT} ${MUTED}`}>
        Ask for {ask.to.map((a) => (a.me ? "you" : a.name)).join(", ")}
      </p>
      <p className={`${TXT} font-semibold break-words`}>{ask.question}</p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {ask.options.map((o) => {
          const rec = ask.recommended?.optionId === o.id;
          return (
            <li key={o.id}>
              <Button
                variant="outline"
                size="sm"
                className="h-auto w-full justify-start gap-2 py-1 text-left whitespace-normal"
                disabled={!canAnswer || answer.isPending}
                aria-pressed={picked === o.id}
                data-option={o.id}
                onClick={() => {
                  setErr(null);
                  answer.mutate(
                    { thread: thread.id, comment: c.id, optionId: o.id },
                    { onError: setErr },
                  );
                }}
              >
                <span className="min-w-0 flex-1 break-words">
                  <b>{o.label}</b>
                  {rec && (
                    <span className={`ml-2 ${TXT} font-medium`}>
                      Recommended
                    </span>
                  )}
                  {o.detail && (
                    <span className={`block font-normal ${MUTED}`}>
                      {o.detail}
                    </span>
                  )}
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
      {ask.recommended?.why && (
        <p className={`${TXT} ${MUTED} break-words`}>
          Why: {ask.recommended.why}
        </p>
      )}
      {ask.answer && pickedOpt && (
        <p className={`${TXT} font-medium`} data-ask-answer="">
          {ask.answer.by.me ? "You" : ask.answer.by.name} picked{" "}
          {pickedOpt.label} · {versionDate(ask.answer.at)}
          {ask.closed ? " · closed" : ""}
        </p>
      )}
      {!mine && !ask.closed && (
        <p className={`${TXT} ${MUTED}`}>Only the people asked can answer.</p>
      )}
      {err != null && (
        <p role="alert" className={`${TXT} text-destructive`}>
          {answerError(err)}
        </p>
      )}
      <div className="flex gap-2">
        {next && (
          <Button size="xs" variant="outline" onClick={next}>
            Next ask
          </Button>
        )}
        {open && (
          <Button size="xs" variant="ghost" onClick={() => setOpen(false)}>
            Hide
          </Button>
        )}
      </div>
    </div>
  );
}

/** The @ picker's matches for the text before the caret, or null when no mention is being typed. */
export function mentionQuery(before: string): string | null {
  const m = /(?:^|\s)@([\w .-]{0,40})$/.exec(before);
  return m ? (m[1] ?? "") : null;
}

export function MentionMenu({
  agents,
  query,
  onPick,
}: {
  agents: readonly ArtifactAgent[];
  query: string;
  onPick: (a: ArtifactAgent) => void;
}) {
  const q = query.toLowerCase();
  const list = agents.filter((a) => a.name.toLowerCase().includes(q));
  return (
    <div
      role="listbox"
      aria-label="Agents on this page"
      className="rounded-md border border-border bg-background"
    >
      {list.length === 0 ? (
        <p className={`p-2 ${TXT} ${MUTED}`}>
          No agent works on this page with that name.
        </p>
      ) : (
        list.map((a) => (
          <button
            key={a.key}
            type="button"
            role="option"
            aria-selected="false"
            className={`flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-2 py-1 text-left ${TXT} hover:bg-muted`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(a)}
          >
            <b className="min-w-0 flex-1 truncate">{a.name}</b>
            <span className={MUTED}>{a.online ? "online" : "offline"}</span>
          </button>
        ))
      )}
    </div>
  );
}
