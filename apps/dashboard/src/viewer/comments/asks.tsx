import type {
  ArtifactAgent,
  CommentMention,
  Comment as CommentT,
  CommentThread,
  KeyRef,
} from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useEffect, useId, useState } from "react";
import { answerError, useAnswerAsk } from "../../api/comments";
import { TXT } from "../ui";
import { versionDate } from "../versionDate";

const MUTED = "text-muted-foreground";

/** What the composer sends beyond the text. */
export type Extras = { mentions: KeyRef[] };

export const extrasBody = (x: Extras) => ({
  ...(x.mentions.length ? { mentions: x.mentions } : {}),
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

/**
 * The next unanswered ask for the viewer after `fromId`, in page order (whole-page
 * asks, then by position, then earlier text), wrapping. Never `fromId` itself.
 */
export function nextAskFor(
  api: {
    ordered: readonly CommentThread[];
    orphans: readonly CommentThread[];
  },
  fromId: string | null,
  opts: { includeSelf?: boolean } = {},
): string | undefined {
  const all = [...api.ordered, ...api.orphans];
  const order = all.map((t) => t.id);
  const pending = new Set(asksForMe(all));
  const at = fromId ? order.indexOf(fromId) : -1;
  const next = [...order.slice(at + 1), ...order.slice(0, Math.max(at, 0))]
    .filter((id) => id !== fromId)
    .find((id) => pending.has(id));
  return (
    next ??
    (opts.includeSelf && fromId && pending.has(fromId) ? fromId : undefined)
  );
}

const OFFLINE = "offline · it will get this when it's back";

/** "Codex is offline · it will get this when it's back", "Claude Code: Delivered". */
const deliveryLine = (name: string, d: CommentMention["delivery"]) =>
  d === "queued"
    ? `${name} is ${OFFLINE}`
    : d === "gone"
      ? `${name} is gone · mention another agent`
      : `${name}: ${d === "seen" ? "Seen" : "Delivered"}`;
/** Delivery of each mention, in plain words. Names are text, never HTML. */
export function Delivery({ c }: { c: CommentT }) {
  if (!c.mentions?.length) return null;
  return (
    <ul className={`m-0 list-none p-0 ${TXT} ${MUTED}`}>
      {c.mentions?.map((m) => (
        <li key={m.key} data-mention={m.key}>
          {deliveryLine(m.name, m.delivery)}
        </li>
      ))}
    </ul>
  );
}

const letter = (i: number) => String.fromCharCode(65 + i);

/** The ask on a comment: question, options, recommendation, and the answer buttons for those it is addressed to. */
export function AskBlock({
  artifactId,
  thread,
  c,
  next,
  reply,
}: {
  artifactId: string;
  thread: CommentThread;
  c: CommentT;
  /** Jump to the next unanswered ask, when there is one. */
  next?: () => void;
  /** Open this thread's reply composer, when the viewer may comment. */
  reply?: () => void;
}) {
  const ask = c.ask;
  const answer = useAnswerAsk(artifactId);
  const [err, setErr] = useState<unknown>(null);
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const qid = useId();
  const picked = ask?.answer?.optionId;
  // A later answer, even one made elsewhere, ends the old failure and the Change mode.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `picked` is the trigger.
  useEffect(() => {
    setErr(null);
    setChanging(false);
  }, [picked]);
  if (!ask) return null;
  const mine = ask.to.some((a) => a.me);
  const canAnswer = mine && !ask.closed;
  const pickedIdx = ask.options.findIndex((o) => o.id === picked);
  const pickedOpt = ask.options[pickedIdx];
  const locked = !!pickedOpt && !changing;
  const decided = ask.closed && pickedOpt;
  const line = decided && (
    <>
      <button
        type="button"
        data-ask-decided=""
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-[var(--oa-success-soft)] px-2 py-1 text-left font-medium text-[var(--oa-success-fg)] ${TXT}`}
      >
        <span className="min-w-0 flex-1 break-words">
          {ask.question.trimEnd().endsWith("?")
            ? `${ask.question} `
            : `${ask.question}: `}
          {pickedOpt.label} · {ask.answer?.by.me ? "you" : ask.answer?.by.name},{" "}
          {versionDate(ask.answer?.at ?? "")}
        </span>
        <span className="shrink-0 font-semibold">
          {open ? "Hide" : "Show"}{" "}
          <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        </span>
      </button>
      {reply && (
        <Button
          size="xs"
          variant="link"
          className="h-auto self-start p-0"
          onClick={reply}
        >
          Reply to ask for a change
        </Button>
      )}
    </>
  );
  return (
    <div className="flex flex-col gap-1">
      {line}
      {(!decided || open) && (
        <div
          // Amber only while it needs this reader: an ask for you with no pick yet.
          className={`flex flex-col gap-2 rounded-md p-2 ring-1 ${
            canAnswer && !pickedOpt ? "ring-[var(--oa-warning)]" : "ring-border"
          }`}
          data-ask=""
          data-needs-you={canAnswer && !pickedOpt ? "" : undefined}
        >
          {/* The card's own header already names the asker and the time. */}
          <p className={`${TXT} ${MUTED}`}>Ask</p>
          <p id={qid} className={`${TXT} font-semibold break-words`}>
            {ask.question}
          </p>
          <ul
            aria-labelledby={qid}
            className="m-0 flex list-none flex-col gap-1 p-0"
          >
            {ask.options.map((o, i) => {
              const rec = ask.recommended?.optionId === o.id;
              const sel = picked === o.id;
              return (
                <li key={o.id}>
                  <Button
                    variant="outline"
                    size="sm"
                    className={`h-auto w-full items-start justify-start gap-2 py-1 text-left whitespace-normal ${
                      sel
                        ? "bg-[var(--oa-accent-soft)] ring-2 ring-[var(--oa-accent)] disabled:opacity-100"
                        : ""
                    }`}
                    disabled={
                      !canAnswer || answer.isPending || sel || (locked && !sel)
                    }
                    aria-pressed={sel}
                    data-option={o.id}
                    onClick={() => {
                      setErr(null);
                      answer.mutate(
                        { thread: thread.id, comment: c.id, optionId: o.id },
                        { onError: setErr },
                      );
                    }}
                  >
                    <span
                      data-option-key=""
                      className="mt-0.5 shrink-0 rounded bg-[var(--oa-accent-soft)] px-1.5 font-mono text-[length:var(--oa-text-xs)] font-semibold"
                    >
                      {letter(i)}
                    </span>
                    <span className="min-w-0 flex-1 break-words">
                      <b>{o.label}</b>
                      {rec && (
                        <span
                          className={`ml-2 rounded bg-[var(--oa-success-soft)] px-1.5 ${TXT} font-semibold text-[var(--oa-success-fg)]`}
                        >
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
              {letter(pickedIdx)} · {versionDate(ask.answer.at)}
              {ask.closed ? " · closed" : ""}
              {canAnswer && locked && (
                <>
                  {" · "}
                  <Button
                    size="xs"
                    variant="link"
                    className="h-auto p-0"
                    onClick={() => setChanging(true)}
                  >
                    Change
                  </Button>
                </>
              )}
            </p>
          )}
          {!mine && !ask.closed && (
            <p className={`${TXT} ${MUTED}`}>
              Only the people asked can answer.
            </p>
          )}
          {err != null && (
            <p role="alert" className={`${TXT} text-destructive`}>
              {answerError(err)}
            </p>
          )}
          <div className="flex gap-2">
            {next && canAnswer && (
              <Button size="xs" variant="outline" onClick={next}>
                Next ask ↓
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The @ picker's matches for the text before the caret, or null when no mention is being typed. */
export function mentionQuery(before: string): string | null {
  // A trailing "-" or "." is punctuation after the name ("@Bob-"), not part of it.
  const m = /(?:^|\s)@([\w .-]{0,40}?)[.-]*$/.exec(before);
  return m ? (m[1] ?? "") : null;
}

/**
 * Agents the picker offers for a query; null (no picker) once the query has run past a
 * whole agent name plus a space ("@OA Design " is a finished mention).
 */
export function matchAgents(
  agents: readonly ArtifactAgent[],
  query: string,
): ArtifactAgent[] | null {
  const q = query.toLowerCase();
  // A finished mention, unless a longer name still fits ("@OA " with "OA Design").
  const done = agents.filter((a) => q.startsWith(`${a.name.toLowerCase()} `));
  if (
    done.length &&
    !agents.some(
      (a) =>
        a.name.toLowerCase().startsWith(q) &&
        !done.some((d) => d.key === a.key),
    )
  )
    return null;
  return agents.filter((a) => a.name.toLowerCase().includes(q));
}

const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Keys of the agents named as "@Name" in the text: after the start or
 * whitespace (so not in an email), before the end, whitespace or punctuation.
 * Longest names first, and a matched span is used up, so "@Bob" is not also "Bo".
 */
export function mentionedKeys(
  text: string,
  agents: readonly ArtifactAgent[],
): string[] {
  let rest = text;
  const keys: string[] = [];
  for (const a of [...agents].sort((x, y) => y.name.length - x.name.length)) {
    const re = new RegExp(
      `(^|\\s)@${esc(a.name)}(?=$|[\\s.,;:!?)\\]]|-(?=$|\\s)|['\u2019]s(?!\\w))`,
      "i",
    );
    const m = re.exec(rest);
    if (!m) continue;
    keys.push(a.key);
    const at = m.index + (m[1]?.length ?? 0);
    rest =
      rest.slice(0, at) +
      " ".repeat(a.name.length + 1) +
      rest.slice(at + a.name.length + 1);
  }
  return keys;
}

const MENTION_END = "(?=$|[\\s.,;:!?)\\]]|-(?=$|\\s)|['\u2019]s(?!\\w))";

/** Drops every `@name` that `mentionedKeys` would count (same boundary), with a
    trailing `'s` and the space before it. An `@name` that is the start of a longer agent's
    name is left alone. */
export function removeMention(
  text: string,
  name: string,
  agents: readonly ArtifactAgent[] = [],
): string {
  const longer = agents
    .filter(
      (a) =>
        a.name.length > name.length &&
        a.name.toLowerCase().startsWith(name.toLowerCase()),
    )
    .map((a) => new RegExp(`^@${esc(a.name)}${MENTION_END}`, "i"));
  const re = new RegExp(
    `(^|\\s)@${esc(name)}${MENTION_END}(?:['\u2019]s)?`,
    "gi",
  );
  let atStart = false;
  const out = text.replace(re, (m, lead: string, at: number) => {
    if (longer.some((l) => l.test(text.slice(at + lead.length)))) return m;
    if (at === 0) atStart = true;
    // The space before it goes too, so "hi @Bob." leaves "hi." and
    // "a @Bob b" leaves "a b"; the space after stays for the next match. A
    // line break before it stays, so lines are not joined.
    return /[\r\n]/.test(lead) ? lead : "";
  });
  return atStart ? out.trimStart() : out;
}

/** A posted body with each `@name` from its mentions as a chip. Text spans only,
    never HTML; a body with no mentions is the plain string. */
export function MentionedText({
  body,
  mentions,
}: {
  body: string;
  mentions?: readonly { key: string; name: string }[];
}) {
  if (!mentions?.length) return <>{body}</>;
  const names = [...new Set(mentions.map((m) => m.name))]
    .sort((x, y) => y.length - x.length)
    .map(esc);
  const re = new RegExp(`(^|\\s)@(${names.join("|")})${MENTION_END}`, "gi");
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of body.matchAll(re)) {
    const at = m.index + (m[1]?.length ?? 0);
    const end = at + 1 + (m[2]?.length ?? 0);
    if (at > last) out.push(body.slice(last, at));
    out.push(
      <span
        key={at}
        data-mention-chip=""
        className="rounded-full bg-[var(--oa-accent-soft)] px-1 py-0.5 text-[var(--oa-accent-fg)]"
      >
        {body.slice(at, end)}
      </span>,
    );
    last = end;
  }
  if (last === 0) return <>{body}</>;
  if (last < body.length) out.push(body.slice(last));
  return <>{out}</>;
}

/** Who gets notified: the mentioned agents. */
export function notifyNames(
  text: string,
  agents: readonly ArtifactAgent[],
): string[] {
  const keys = new Set(mentionedKeys(text, agents));
  return agents.filter((a) => keys.has(a.key)).map((a) => a.name);
}

/** The picked mentions as removable chips, and the "Will notify" line. */
export function MentionChips({
  text,
  agents,
  onRemove,
}: {
  text: string;
  agents: readonly ArtifactAgent[];
  onRemove: (a: ArtifactAgent) => void;
}) {
  const keys = mentionedKeys(text, agents);
  const chips = agents.filter((a) => keys.includes(a.key));
  const names = notifyNames(text, agents);
  return (
    <div aria-live="polite" className={`flex flex-col gap-1 ${TXT}`}>
      {names.length > 0 && chips.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
          {chips.map((a) => (
            <li
              key={a.key}
              data-chip={a.key}
              className="inline-flex items-center gap-1 rounded-full bg-[var(--oa-accent-soft)] py-0.5 pr-1 pl-2 text-[var(--oa-accent-fg)]"
            >
              @{a.name}
              <button
                type="button"
                aria-label={`Remove mention of ${a.name}`}
                className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-full leading-none hover:bg-background/60"
                onClick={() => onRemove(a)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {names.length > 0 && (
        <p className={`m-0 ${MUTED}`}>Will notify {names.join(", ")}</p>
      )}
    </div>
  );
}

export function MentionMenu({
  id,
  matches,
  active,
  onPick,
}: {
  id: string;
  matches: readonly ArtifactAgent[];
  active: number;
  onPick: (a: ArtifactAgent) => void;
}) {
  return (
    <div
      id={id}
      role="listbox"
      aria-label="Agents on this page"
      className="rounded-md border border-border bg-background"
    >
      {matches.length === 0 ? (
        <p className={`p-2 ${TXT} ${MUTED}`}>
          No agent works on this page with that name.
        </p>
      ) : (
        matches.map((a, i) => (
          <div
            key={a.key}
            id={`${id}-${i}`}
            role="option"
            tabIndex={-1}
            aria-selected={i === active}
            className={`flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-left ${TXT} hover:bg-muted aria-selected:bg-muted`}
            // Picked on mouse down so the textarea keeps focus; the keys are on the textarea.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(a);
            }}
          >
            <span
              aria-hidden="true"
              className={`size-2 shrink-0 rounded-full ${a.online ? "bg-[var(--oa-success-fg,#157a3a)]" : "bg-muted-foreground/50"}`}
            />
            <b className="min-w-0 flex-1 truncate">{a.name}</b>
            <span className={MUTED}>{a.online ? "online" : "offline"}</span>
          </div>
        ))
      )}
    </div>
  );
}
