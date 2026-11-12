import type {
  ArtifactAgent,
  CommentMention,
  Comment as CommentT,
  CommentThread,
  KeyRef,
} from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { CheckCheck, Clock, Minus } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  answerError,
  useAnswerAsk,
  useCommentErrorCtx,
} from "../../api/comments";
import { TXT } from "../ui";
import { versionDate } from "../versionDate";
import { PartyFace } from "./AuthorFace";
import { linkify } from "./linkify";

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

type DState = CommentMention["delivery"];
const isWait = (d: DState) => d === "queued" || d === "gone";

/** #2229: the details a mark opens, always "<agent>: <state>". A mention's gone is its own word. */
export const markText = (name: string, d: DState, mention = false) =>
  `${name}: ${
    d === "queued"
      ? "held until it's back"
      : d === "gone"
        ? mention
          ? "not on the bus"
          : "expired, offline too long"
        : d === "withdrawn"
          ? "removed before delivery"
          : d === "seen"
            ? "seen"
            : "delivered"
  }`;

/** Two ticks for delivered or seen, a clock for held or expired. */
export function DeliveryIcon({ d }: { d: DState }) {
  if (d === "withdrawn")
    return (
      <Minus
        aria-hidden="true"
        data-mark="removed"
        className="size-3.5 text-muted-foreground"
      />
    );
  return isWait(d) ? (
    <Clock
      aria-hidden="true"
      data-mark="wait"
      className="size-3.5 text-[var(--oa-warning)]"
    />
  ) : (
    <CheckCheck
      aria-hidden="true"
      data-mark="ok"
      className="size-3.5 text-[var(--oa-success)]"
    />
  );
}

/** Open on hover and focus, toggle on tap or click, close on Escape or leaving. */
function useDetail() {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [tap, setTap] = useState(false);
  return {
    open: hover || focus || tap,
    props: {
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => {
        setHover(false);
        setTap(false);
      },
      onFocus: () => setFocus(true),
      onBlur: () => {
        setFocus(false);
        setTap(false);
      },
      onClick: () => setTap((t) => !t),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === "Escape") {
          setHover(false);
          setFocus(false);
          setTap(false);
        }
      },
    },
  };
}

const FLOAT =
  "absolute top-full z-20 mt-1 flex min-w-max flex-col gap-1 rounded-md border bg-popover px-2 py-1.5 text-popover-foreground shadow-md";

/** A mention chip with its delivery mark inside, details floating over the thread. */
function MarkedChip({
  text,
  face,
  p,
  guest,
}: {
  text: string;
  face: Parameters<typeof PartyFace>[0]["p"] & {
    name: string;
    delivery: DState;
  };
  p: Parameters<typeof PartyFace>[0]["p"];
  guest: boolean;
}) {
  const { open, props } = useDetail();
  const detail = markText(face.name, face.delivery, true);
  return (
    <span className="relative inline-block align-middle">
      <button
        type="button"
        data-mention-chip=""
        data-delivery={face.delivery}
        aria-label={detail}
        aria-expanded={open}
        className="inline-flex cursor-pointer items-center gap-1 rounded-full border-0 bg-[var(--oa-accent-soft)] px-1 py-0.5 text-[var(--oa-accent-fg)] font-[inherit] text-[length:inherit]"
        {...props}
      >
        <PartyFace p={p} guest={guest} />
        {text}
        <DeliveryIcon d={face.delivery} />
      </button>
      {open && (
        <span
          role="tooltip"
          data-delivery-detail=""
          className={`${FLOAT} left-0 ${TXT}`}
        >
          {detail}
        </span>
      )}
    </span>
  );
}

/** #2229: a problem's sentence, shown on the first comment it happens in. */
const problemLine = (name: string, d: DState, notified: boolean) =>
  d === "queued"
    ? `${name} is offline. Held until it's back.`
    : notified
      ? `${name} didn't get this: it was offline too long. @-mention it to try again.`
      : `${name} isn't on the bus anymore. Mention another agent.`;

type Problem = { id: string; m: CommentMention; notified: boolean };

/** Per comment, the problems that are new in it: an agent held or expired in an
    earlier comment of the thread is not told again, only marked. */
export function newProblems(comments: readonly CommentT[]) {
  const seen = new Set<string>();
  const out = new Map<string, Problem[]>();
  for (const c of comments) {
    const list: Problem[] = [];
    const add = (m: CommentMention, notified: boolean) => {
      if (!isWait(m.delivery)) return;
      const id = `${m.key}:${m.delivery}`;
      if (seen.has(id)) return;
      seen.add(id);
      list.push({ id: `${notified ? "n" : "m"}-${m.key}`, m, notified });
    };
    for (const m of c.mentions ?? []) add(m, false);
    for (const m of c.notified ?? []) add(m, true);
    if (list.length) out.set(c.id, list);
  }
  return out;
}

/** The sentence for each new problem. Marks live on the chip and in the header. Names are text, never HTML. */
export function Delivery({
  c,
  guest = false,
  problems,
}: {
  c: CommentT;
  guest?: boolean;
  /** What is new in this comment; by default whatever is wrong in it. */
  problems?: readonly Problem[];
}) {
  const list = problems ?? newProblems([c]).get(c.id) ?? [];
  if (!list.length) return null;
  return (
    <ul className={`m-0 list-none p-0 ${TXT} ${MUTED}`}>
      {list.map(({ id, m, notified }) => (
        <li
          key={id}
          {...(notified
            ? { "data-notified": m.key }
            : { "data-mention": m.key })}
          className="flex items-center gap-1"
        >
          <PartyFace p={m} guest={guest} />
          {problemLine(m.name, m.delivery, notified)}
        </li>
      ))}
    </ul>
  );
}

/** #2229: agents told without a mention, as up to three faces and one summary mark in the header. */
export function DeliveryFaces({
  told: all,
  compact = false,
}: {
  told: readonly CommentMention[];
  /** A tight header: the summary mark and its count, no faces. */
  compact?: boolean;
}) {
  const { open, props } = useDetail();
  if (!all.length) return null;
  // A removed notice was never sent: it is listed in the details, not counted.
  const told = all.filter((m) => m.delivery !== "withdrawn");
  const sorted = [...told].sort(
    (a, b) => Number(isWait(b.delivery)) - Number(isWait(a.delivery)),
  );
  const ok = told.filter((m) => !isWait(m.delivery)).length;
  const held = told.length - ok;
  const label = !told.length
    ? "Removed before delivery"
    : `${ok} of ${told.length} delivered`;
  return (
    <span className="relative inline-flex shrink-0" data-delivery-faces="">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        className="inline-flex cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent p-0.5 text-muted-foreground"
        {...props}
      >
        {!compact && (
          // 3px overlap, each face ringed in the card's colour, the first on top (as #2185's stack).
          <span className="inline-flex">
            {sorted.slice(0, 3).map((m, i, all) => (
              <span
                key={m.key}
                data-face=""
                style={{ zIndex: all.length - i, marginLeft: i === 0 ? 0 : -3 }}
                className="relative inline-flex shrink-0 rounded-md bg-card ring-[1.5px] ring-card"
              >
                <PartyFace p={m} />
              </span>
            ))}
          </span>
        )}
        {!compact && told.length > 3 && (
          <span className={TXT} data-more="">
            +{told.length - 3}
          </span>
        )}
        <DeliveryIcon
          d={!told.length ? "withdrawn" : held ? "queued" : "delivered"}
        />
        {held > 0 && (
          <span className={TXT} data-summary="">
            {ok} of {told.length}
          </span>
        )}
      </button>
      {open && (
        <span
          role="tooltip"
          data-delivery-detail=""
          className={`${FLOAT} right-0 ${TXT}`}
        >
          {[...sorted, ...all.filter((m) => m.delivery === "withdrawn")].map(
            (m) => (
              <span
                key={m.key}
                data-told={m.key}
                className="flex items-center gap-1.5"
              >
                <PartyFace p={m} />
                {markText(m.name, m.delivery)}
              </span>
            ),
          )}
        </span>
      )}
    </span>
  );
}

/** Who did it, in words: "you" for the viewer's own act, never for their agent
    (#1789: an owner's token answers with \`me\` set), and "<name> (agent)" for an agent. */
export const actor = (
  a: { kind: string; name: string; me: boolean },
  you: string,
) => (a.kind === "agent" ? `${a.name} (agent)` : a.me ? you : a.name);

/** Who an ask is for: " you", else the addressees as the API names them (masked ones stay masked). */
const askedWho = (to: { name: string }[], mine: boolean) => {
  if (mine) return " you";
  const [a, b] = to;
  if (!a) return "";
  if (!b) return ` ${a.name}`;
  return to.length === 2
    ? ` ${a.name} and ${b.name}`
    : ` ${a.name} and ${to.length - 1} others`;
};

const letter = (i: number) => String.fromCharCode(65 + i);
/** Letters are shown unless every option's id already equals its label ("yes"/"Yes"). */
const showLetters = (opts: { id: string; label: string }[]) =>
  !opts.every(
    (o) => o.id.trim().toLowerCase() === o.label.trim().toLowerCase(),
  );

/** The ask on a comment: question, options, recommendation, and the answer buttons for those it is addressed to. */
export function AskBlock({
  artifactId,
  thread,
  c,
  next,
  reply,
  askQuestion,
  guest = false,
}: {
  artifactId: string;
  /** A guest sees the masked name and no tile (#1890). */
  guest?: boolean;
  thread: CommentThread;
  c: CommentT;
  /** Jump to the next unanswered ask, when there is one. */
  next?: () => void;
  /** Open this thread's reply composer, when the viewer may comment. */
  reply?: () => void;
  /** Open a question to the agent that asked (#1794), when the viewer may reply. */
  askQuestion?: () => void;
}) {
  const ask = c.ask;
  const answer = useAnswerAsk(artifactId);
  const [err, setErr] = useState<unknown>(null);
  const errCtx = useCommentErrorCtx();
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
  // Addressed agents with identity fields; legacy ones add no line, and the
  // server sends none to a signed-out, guest or restricted viewer (#1890).
  const asked = ask.to.filter(
    (a) => a.kind === "agent" && a.linked !== undefined,
  );
  const canAnswer = mine && !ask.closed;
  const pickedIdx = ask.options.findIndex((o) => o.id === picked);
  const pickedOpt = ask.options[pickedIdx];
  const recIdx = ask.options.findIndex(
    (o) => o.id === ask.recommended?.optionId,
  );
  const letters = showLetters(ask.options);
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
          {letters ? `${letter(pickedIdx)}, ` : ""}
          {pickedOpt.label} · {ask.answer ? actor(ask.answer.by, "you") : ""},{" "}
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
          <p className={`${TXT} ${MUTED}`} data-ask-from="">
            {c.author.name}
            {c.author.kind === "agent" && (
              <>
                {" "}
                <span
                  data-agent-tag=""
                  className="rounded-full border border-primary/30 bg-primary/10 px-1.5 text-[length:var(--oa-text-xs)] text-foreground"
                >
                  agent
                </span>
              </>
            )}{" "}
            asks{askedWho(ask.to, mine)}
          </p>
          <p id={qid} className={`${TXT} font-semibold break-words`}>
            {linked(ask.question, 0)}
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
                    className={`h-auto min-h-10 w-full items-center justify-start gap-2 py-1 text-left whitespace-normal ${
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
                    {letters && (
                      <span
                        data-option-key=""
                        className="mt-0.5 shrink-0 rounded bg-[var(--oa-accent-soft)] px-1.5 font-mono text-[length:var(--oa-text-xs)] font-semibold"
                      >
                        {letter(i)}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 break-words">
                      <b>{o.label}</b>
                      {o.detail && (
                        <span className={`block font-normal ${MUTED}`}>
                          {o.detail}
                        </span>
                      )}
                    </span>
                    {rec && (
                      <span
                        className={`ml-auto shrink-0 rounded bg-[var(--oa-success-soft)] px-1.5 ${TXT} font-semibold text-[var(--oa-success-fg)]`}
                      >
                        Recommended
                      </span>
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
          {ask.recommended?.why && (
            <p className={`${TXT} ${MUTED} break-words`}>
              Why{recIdx >= 0 && letters ? ` ${letter(recIdx)}` : ""}:{" "}
              {ask.recommended.why}
            </p>
          )}
          {ask.answer && pickedOpt && (
            <p className={`${TXT} font-medium`} data-ask-answer="">
              {actor(ask.answer.by, "You")} picked{" "}
              {letters ? letter(pickedIdx) : pickedOpt.label} ·{" "}
              {versionDate(ask.answer.at)}
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
          {asked.length > 0 && (
            <p
              data-ask-to=""
              className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${TXT} ${MUTED}`}
            >
              To
              {asked.map((a, i) => (
                <span
                  key={a.id ?? `${a.name}-${i}`}
                  className="inline-flex items-center gap-1"
                >
                  <PartyFace p={a} />
                  {a.name}
                </span>
              ))}
            </p>
          )}
          {!mine && !ask.closed && (
            <p className={`${TXT} ${MUTED}`}>
              Only the people asked can answer.
            </p>
          )}
          {err != null && (
            <p role="alert" className={`${TXT} text-destructive`}>
              {answerError(err, errCtx)}
            </p>
          )}
          <div className="flex gap-2">
            {askQuestion && !pickedOpt && !ask.closed && (
              <Button size="xs" variant="outline" onClick={askQuestion}>
                Ask a question
              </Button>
            )}
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
  return sortAgents(agents.filter((a) => a.name.toLowerCase().includes(q)));
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
  guest = false,
  marks,
}: {
  body: string;
  mentions?: readonly (Parameters<typeof PartyFace>[0]["p"] & {
    key: string;
    name: string;
    delivery?: DState;
  })[];
  guest?: boolean;
  /** #2229: show each mention's delivery in its chip. */
  marks?: boolean;
}) {
  if (!mentions?.length) return <>{linked(body, 0)}</>;
  const names = [...new Set(mentions.map((m) => m.name))]
    .sort((x, y) => y.length - x.length)
    .map(esc);
  const re = new RegExp(`(^|\\s)@(${names.join("|")})${MENTION_END}`, "gi");
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of body.matchAll(re)) {
    const at = m.index + (m[1]?.length ?? 0);
    const end = at + 1 + (m[2]?.length ?? 0);
    // The chip is text, so it has only a name: two agents sharing it are
    // ambiguous and get no face rather than the wrong one.
    const same = mentions.filter(
      (x) => x.name.toLowerCase() === (m[2] ?? "").toLowerCase(),
    );
    const face = same.length === 1 ? same[0] : undefined;
    if (at > last) out.push(...linked(body.slice(last, at), last));
    if (marks && !guest && face?.delivery) {
      out.push(
        <MarkedChip
          key={at}
          text={body.slice(at, end)}
          face={face as typeof face & { delivery: DState }}
          p={face}
          guest={guest}
        />,
      );
      last = end;
      continue;
    }
    out.push(
      <span
        key={at}
        data-mention-chip=""
        className="inline-flex items-center gap-1 rounded-full bg-[var(--oa-accent-soft)] px-1 py-0.5 align-middle text-[var(--oa-accent-fg)]"
      >
        {face && <PartyFace p={face} guest={guest} />}
        {body.slice(at, end)}
      </span>,
    );
    last = end;
  }
  if (last === 0) return <>{linked(body, 0)}</>;
  if (last < body.length) out.push(...linked(body.slice(last), last));
  return <>{out}</>;
}

/** Plain text with its http(s) URLs as links that open in a new tab. */
function linked(text: string, base: number): React.ReactNode[] {
  let at = base;
  return linkify(text).map((p) => {
    const key = at;
    at += p.text.length;
    return p.url ? (
      <a
        key={key}
        href={p.text}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all underline"
      >
        {p.text}
      </a>
    ) : (
      p.text
    );
  });
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

const isOnline = (a: ArtifactAgent) =>
  a.state === "online" || (a.state === undefined && a.online);

const isUnknown = (a: ArtifactAgent) => a.state === undefined && !a.online;
const rankOf = (a: ArtifactAgent) => (isOnline(a) ? 0 : isUnknown(a) ? 2 : 1);

/** Online first, then away, then agents with no state (the bus did not answer); each alphabetical. */
export function sortAgents(agents: readonly ArtifactAgent[]): ArtifactAgent[] {
  return [...agents].sort(
    (x, y) =>
      rankOf(x) - rankOf(y) ||
      x.name.localeCompare(y.name, "en", { sensitivity: "base" }),
  );
}

/** "OA Manager-2" and "OA Manager (Sam)" both have the stem "oa manager". */
const stemOf = (name: string) =>
  name
    .replace(/ \([^)]*\)$/, "")
    .replace(/-\d+$/, "")
    .toLowerCase();

/** "19h", "5m", "3d": how long ago an away session was last active. */
function ago(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(t)) return "";
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

/**
 * "online" or "away 19h" for the viewer's own agent, with the machine after a
 * dot when the name stem repeats among their own agents. Another member's
 * agent leads with its owner and shows the state alone: "online · Sam's".
 */
function stateText(a: ArtifactAgent, all: readonly ArtifactAgent[]): string {
  // No state at all: the bus did not answer, so nothing is claimed (an empty column; "Sam's" alone for another member's).
  if (a.state === undefined && !a.online && !a.owner) return "";
  if (a.owner && a.state === undefined && !a.online) return `${a.owner}'s`;
  if (a.owner) return `${isOnline(a) ? "online" : "away"} \u00b7 ${a.owner}'s`;
  const head = isOnline(a)
    ? "online"
    : ["away", ago(a.lastActiveAt)].filter(Boolean).join(" ");
  const stem = stemOf(a.name);
  const repeats =
    all.filter((o) => !o.owner && stemOf(o.name) === stem).length > 1;
  return repeats && a.machine ? `${head} \u00b7 ${a.machine}` : head;
}

/** The row's name: the bare agent name when the status line already names the owner ("Sam's"). */
const rowName = (a: ArtifactAgent) =>
  a.owner && a.name.endsWith(` (${a.owner})`)
    ? a.name.slice(0, -` (${a.owner})`.length)
    : a.name;

export function MentionMenu({
  id,
  matches,
  all = matches,
  active,
  onPick,
}: {
  id: string;
  matches: readonly ArtifactAgent[];
  /** Every agent on the menu's roster: a machine shows on rows whose name stem repeats among these. */
  all?: readonly ArtifactAgent[];
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
            className={`flex w-full cursor-pointer items-center gap-2 border-l-[3px] border-transparent px-2 py-1 text-left ${TXT} hover:bg-muted aria-selected:border-[var(--oa-accent)] aria-selected:bg-[var(--oa-accent-soft)]`}
            // Picked on mouse down so the textarea keeps focus; the keys are on the textarea.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(a);
            }}
          >
            {!isUnknown(a) && (
              <span
                aria-hidden="true"
                className={`size-2 shrink-0 rounded-full ${isOnline(a) ? "bg-[var(--oa-success-fg,#157a3a)]" : "border-[1.5px] border-muted-foreground"}`}
              />
            )}
            <b
              className={`min-w-0 flex-1 truncate ${a.state === "away" ? MUTED : ""}`}
            >
              {rowName(a)}
            </b>
            <span className={MUTED}>{stateText(a, all)}</span>
          </div>
        ))
      )}
    </div>
  );
}
