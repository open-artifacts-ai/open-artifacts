import type {
  ArtifactAgent,
  CommentMention,
  CommentNotified,
  Comment as CommentT,
  CommentThread,
  KeyRef,
  MentionDelivery,
} from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { CheckCheck, Clock, Minus } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  answerError,
  useAnswerAsk,
  useCommentErrorCtx,
} from "../../api/comments";
import { TXT } from "../ui";
import { versionDate } from "../versionDate";
import { PartyFace } from "./AuthorFace";
import { type Face, FaceStack } from "./FaceStack";
import { lastWasTouch, useInputKind } from "./inputKind";
import { Markdown, MarkdownInline } from "./Markdown";

const MUTED = "text-muted-foreground";

/** What the composer sends beyond the text. */
export type Extras = { mentions: KeyRef[] };

export const extrasBody = (x: Extras) => ({
  ...(x.mentions.length ? { mentions: x.mentions } : {}),
});

/** An answer that is only the pick on its way (the optimistic one), not yet the server's record. */
export const isSendingAnswer = (a: object | undefined) =>
  !!a && (a as { sending?: boolean }).sending === true;

/** Open asks addressed to the viewer that nobody has answered, in the given order. */
export function asksForMe(threads: readonly CommentThread[]): string[] {
  return threads
    .filter((t) => t.status === "open")
    .filter((t) =>
      t.comments.some(
        (c) =>
          c.ask &&
          (!c.ask.answer || isSendingAnswer(c.ask.answer)) &&
          c.ask.to.some((a) => a.me),
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

type DState = MentionDelivery;
/** What a mark shows: a queued notice is "sending" until the comment is HELD_AFTER_MS old. */
type Shown = DState | "sending";
const isWait = (d: Shown) => d === "queued" || d === "gone";

/** A queued notice is delivered within moments; it is "held" only after this long. */
export const HELD_AFTER_MS = 30_000;

/** Maps each state to what to show now; re-renders once when the oldest pending one turns held. */
function useShown(createdAt: string | undefined, states: readonly DState[]) {
  const [, tick] = useState(0);
  const born = createdAt ? Date.parse(createdAt) : Number.NaN;
  // The end of "sending", fixed on first sight and clamped: a client clock running
  // behind cannot stretch it past HELD_AFTER_MS from now.
  const until = useRef<number | null>(null);
  if (until.current === null)
    until.current = Number.isNaN(born)
      ? 0
      : Date.now() + Math.min(HELD_AFTER_MS, born + HELD_AFTER_MS - Date.now());
  const end = until.current;
  const sending = Date.now() < end;
  const pending = sending && states.includes("queued");
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => tick((n) => n + 1), end - Date.now() + 5);
    return () => clearTimeout(t);
  }, [pending, end]);
  return (d: DState): Shown => (d === "queued" && sending ? "sending" : d);
}

/** #2229: the details a mark opens, always "<agent>: <state>". A mention's gone is its own word. */
export const markText = (name: string, d: Shown, mention = false) =>
  `${name}: ${
    d === "sending"
      ? "sending"
      : d === "queued"
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
export function DeliveryIcon({ d }: { d: Shown }) {
  if (d === "sending")
    return (
      <Clock
        aria-hidden="true"
        data-mark="sending"
        className="size-3.5 text-muted-foreground"
      />
    );
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

/**
 * Open on hover and focus, toggle on tap or click, close on Escape or leaving.
 * A touch tap toggles on its own (a second tap closes), whatever hover or focus
 * the browser fakes after it; the next keydown or mouse move (a hybrid device)
 * ends "touch", so the keyboard and the mouse open it again (#2247). Escape while open is swallowed, so it does not
 * also close the panel, sheet or full screen behind it. `float` keeps the
 * details inside the comment's column.
 */
function useDetail() {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [tap, setTap] = useState(false);
  useInputKind();
  const float = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  const open = hover || focus || tap;
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured once per opening
  useLayoutEffect(() => {
    const t = float.current;
    const box = t?.closest("[data-comment]");
    if (!open || !t || !box) {
      setShift(0);
      return;
    }
    const r = t.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const left = r.left - shift;
    const right = r.right - shift;
    setShift(
      right > b.right ? b.right - right : left < b.left ? b.left - left : 0,
    );
  }, [open]);
  return {
    open,
    float: {
      ref: float,
      style: shift ? { transform: `translateX(${shift}px)` } : undefined,
    },
    props: {
      onMouseEnter: () => {
        if (!lastWasTouch()) setHover(true);
      },
      onMouseLeave: () => {
        setHover(false);
        setTap(false);
      },
      onFocus: () => {
        if (!lastWasTouch()) setFocus(true);
      },
      onBlur: () => {
        setFocus(false);
        setTap(false);
      },
      onClick: () => setTap((t) => !t),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          e.stopPropagation();
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
  createdAt,
}: {
  text: string;
  face: Parameters<typeof PartyFace>[0]["p"] & {
    name: string;
    delivery: DState;
  };
  p: Parameters<typeof PartyFace>[0]["p"];
  guest: boolean;
  createdAt?: string;
}) {
  const { open, props, float } = useDetail();
  const shown = useShown(createdAt, [face.delivery])(face.delivery);
  const detail = markText(face.name, shown, true);
  const did = useId();
  return (
    <span className="relative inline-block align-middle">
      {/* #2247: the name stays the chip's own text; the state is its description. */}
      <span id={did} hidden>
        {detail}
      </span>
      <button
        type="button"
        data-mention-chip=""
        data-delivery={face.delivery}
        aria-describedby={did}
        aria-expanded={open}
        className="inline-flex cursor-pointer items-center gap-1 rounded-full border-0 bg-[var(--oa-accent-soft)] px-1 py-0.5 text-[var(--oa-accent-fg)] font-[inherit] text-[length:inherit]"
        {...props}
      >
        <PartyFace p={p} guest={guest} />
        {text}
        <DeliveryIcon d={shown} />
      </button>
      {open && (
        <span
          role="tooltip"
          data-delivery-detail=""
          className={`${FLOAT} left-0 ${TXT}`}
          {...float}
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

type Problem = { id: string; m: CommentNotified; notified: boolean };

/** Per comment, the problems that are new in it: an agent held or expired in an
    earlier comment of the thread is not told again, only marked. */
export function newProblems(comments: readonly CommentT[]) {
  const seen = new Set<string>();
  const out = new Map<string, Problem[]>();
  for (const c of comments) {
    const list: Problem[] = [];
    const add = (m: CommentMention, notified: boolean) => {
      if (!m.delivery || !isWait(m.delivery)) return;
      const id = `${m.key}:${m.delivery}`;
      if (seen.has(id)) return;
      seen.add(id);
      list.push({
        id: `${notified ? "n" : "m"}-${m.key}`,
        m: m as CommentNotified,
        notified,
      });
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
  const all = problems ?? newProblems([c]).get(c.id) ?? [];
  // A queued notice is only "held" once the comment is HELD_AFTER_MS old.
  const shownOf = useShown(
    c.createdAt,
    all.map((p) => p.m.delivery),
  );
  const list = all.filter((p) => shownOf(p.m.delivery) !== "sending");
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

/** #2229: everyone a comment notified (the agents it @-mentions, then the thread agents told by a reply), as up to three faces and one summary mark in the header. */
export function DeliveryFaces({
  mentions = [],
  told = [],
  createdAt,
  compact = false,
}: {
  mentions?: readonly CommentNotified[];
  told?: readonly CommentNotified[];
  /** The comment's createdAt: a queued notice reads "sending" until it is HELD_AFTER_MS old. */
  createdAt?: string;
  /** A tight header: the summary mark and its count, no faces. */
  compact?: boolean;
}) {
  const { open, props, float } = useDetail();
  const did = useId();
  const seen = new Set<string>();
  // A mention keeps its own wording for a gone agent ("not on the bus"), as its chip does.
  const merged = [
    ...mentions.map((m) => ({ ...m, mention: true })),
    ...told.map((m) => ({ ...m, mention: false })),
  ].filter((m) => !seen.has(m.key) && seen.add(m.key));
  const shownOf = useShown(
    createdAt,
    merged.map((m) => m.delivery),
  );
  if (!merged.length) return null;
  const all = merged.map((m) => ({ ...m, shown: shownOf(m.delivery) }));
  // A removed notice was never sent: it is listed in the details, not counted.
  const told2 = all.filter((m) => m.shown !== "withdrawn");
  const rank = (d: Shown) => (isWait(d) ? 2 : d === "sending" ? 1 : 0);
  const sorted = [...told2].sort((a, b) => rank(b.shown) - rank(a.shown));
  const ok = told2.filter((m) => rank(m.shown) === 0).length;
  const held = told2.filter((m) => isWait(m.shown)).length;
  const sending = told2.length - ok - held;
  const rows = [...sorted, ...all.filter((m) => m.shown === "withdrawn")];
  const faces: Face[] = sorted.map((m) => ({
    key: m.key,
    round: false,
    el: <PartyFace p={m} />,
  }));
  const label = !told2.length
    ? "Removed before delivery"
    : `${ok} of ${told2.length} delivered`;
  return (
    <span className="relative inline-flex shrink-0" data-delivery-faces="">
      {/* #2247: the label is the name; each agent's state is the description. */}
      <span id={did} hidden>
        {rows.map((m) => markText(m.name, m.shown, m.mention)).join(". ")}
      </span>
      <button
        type="button"
        aria-label={label}
        aria-describedby={did}
        aria-expanded={open}
        className="inline-flex cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent p-0.5 text-muted-foreground"
        {...props}
      >
        {!compact && <FaceStack faces={faces} moreClass={TXT} more />}
        <DeliveryIcon
          d={
            !told2.length
              ? "withdrawn"
              : held
                ? "queued"
                : sending
                  ? "sending"
                  : "delivered"
          }
        />
        {held + sending > 0 && (
          <span className={TXT} data-summary="">
            {ok} of {told2.length}
          </span>
        )}
      </button>
      {open && (
        <span
          role="tooltip"
          data-delivery-detail=""
          className={`${FLOAT} right-0 ${TXT}`}
          {...float}
        >
          {rows.map((m) => (
            <span
              key={m.key}
              data-told={m.key}
              className="flex items-center gap-1.5"
            >
              <PartyFace p={m} />
              {markText(m.name, m.shown, m.mention)}
            </span>
          ))}
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

const squash = (t: string) => t.replace(/\s+/g, " ").trim();
/** An ask's comment body is worth showing unless empty or just the question again. */
export const showsAskBody = (body: string, question: string) =>
  squash(body) !== "" && squash(body) !== squash(question);

/** The ask on a comment: question, options, recommendation, and the answer buttons for those it is addressed to. */
export function AskBlock({
  artifactId,
  thread,
  c,
  next,
  reply,
  askQuestion,
  guest = false,
  body,
}: {
  artifactId: string;
  /** The comment's own text (its steps), shown above the question; the caller renders it. */
  body?: React.ReactNode;
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
  const opts = useRef<HTMLUListElement>(null);
  const [refocus, setRefocus] = useState<string | null>(null);
  // Once the failed pick is rolled back and its option is enabled again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `picked` changes when the rollback lands
  useEffect(() => {
    if (!refocus || answer.isPending) return;
    const el = opts.current?.querySelector<HTMLButtonElement>(
      `[data-option="${CSS.escape(refocus)}"]`,
    );
    if (!el || el.disabled) return;
    el.focus({ preventScroll: true });
    setRefocus(null);
  }, [refocus, answer.isPending, picked]);
  // A later answer, even one made elsewhere, ends the old failure and the Change mode.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `picked` is the trigger.
  useEffect(() => {
    // The rollback after a failed pick (or a 409's refetch) sets it back to
    // unanswered: that failure stays. A new answer ends the old one.
    if (picked === undefined) return;
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
  const sendingPick = isSendingAnswer(ask.answer) || answer.isPending;
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
            canAnswer && (!pickedOpt || sendingPick)
              ? "ring-[var(--oa-warning)]"
              : "ring-border"
          }`}
          data-ask=""
          data-needs-you={
            canAnswer && (!pickedOpt || sendingPick) ? "" : undefined
          }
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
          {body}
          <div id={qid} className={`${TXT} font-semibold break-words`}>
            <Markdown body={ask.question} />
          </div>
          <ul
            ref={opts}
            aria-labelledby={qid}
            aria-busy={answer.isPending || undefined}
            data-sending={answer.isPending ? "" : undefined}
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
                        ? `bg-[var(--oa-accent-soft)] ring-2 ring-[var(--oa-accent)] ${answer.isPending ? "disabled:opacity-60" : "disabled:opacity-100"}`
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
                        {
                          onError: (e) => {
                            setErr(e);
                            // Back to unanswered: focus returns to the option.
                            setRefocus(o.id);
                          },
                        },
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
                          <MarkdownInline body={o.detail} links={false} />
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
          {ask.answer &&
            pickedOpt &&
            !isSendingAnswer(ask.answer) &&
            !answer.isPending && (
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
  return mentionSpans(text, agents).map((s) => s.key);
}

/** Where each counted `@name` sits in the text (`start` at the "@", `end`
    after the name), in the order `mentionedKeys` lists them. */
export function mentionSpans(
  text: string,
  agents: readonly ArtifactAgent[],
): { key: string; start: number; end: number }[] {
  let rest = text;
  const out: { key: string; start: number; end: number }[] = [];
  for (const a of [...agents].sort((x, y) => y.name.length - x.name.length)) {
    const re = new RegExp(
      `(^|\\s)@${esc(a.name)}(?=$|[\\s.,;:!?)\\]]|-(?=$|\\s)|['\u2019]s(?!\\w))`,
      "i",
    );
    const m = re.exec(rest);
    if (!m) continue;
    const at = m.index + (m[1]?.length ?? 0);
    out.push({ key: a.key, start: at, end: at + a.name.length + 1 });
    rest =
      rest.slice(0, at) +
      " ".repeat(a.name.length + 1) +
      rest.slice(at + a.name.length + 1);
  }
  return out;
}

/** #2317: split the text into plain runs and counted mentions (the pills),
    in text order. Joining the `text` of every segment gives the input back. */
export function mentionSegments(
  text: string,
  agents: readonly ArtifactAgent[],
): { text: string; key?: string }[] {
  const spans = mentionSpans(text, agents).sort((x, y) => x.start - y.start);
  const out: { text: string; key?: string }[] = [];
  let last = 0;
  for (const s of spans) {
    if (s.start > last) out.push({ text: text.slice(last, s.start) });
    out.push({ text: text.slice(s.start, s.end), key: s.key });
    last = s.end;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** #2317: Backspace with the caret right after a pill: the range of the whole
    `@name`, to select so the native delete removes it (and stays in the undo
    stack). Null when the key should act normally. */
export function atomicBackspace(
  text: string,
  start: number,
  end: number,
  agents: readonly ArtifactAgent[],
): { start: number; end: number } | null {
  if (start !== end) return null;
  const s = mentionSpans(text, agents).find((m) => m.end === start);
  return s ? { start: s.start, end: s.end } : null;
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

/** A posted body as the safe markdown subset (#2338), with each `@name` from its
    mentions as a chip in its text. Text spans and elements only, never HTML. */
export function MentionedText(props: MentionedProps) {
  return (
    <Markdown body={props.body} text={(s) => <>{mentioned(s, props)}</>} />
  );
}

type MentionedProps = {
  body: string;
  mentions?: readonly (Parameters<typeof PartyFace>[0]["p"] & {
    key: string;
    name: string;
    delivery?: DState;
  })[];
  guest?: boolean;
  /** #2229: show each mention's delivery in its chip. */
  marks?: boolean;
  /** The comment's createdAt, for "sending" before a queued notice is held. */
  createdAt?: string;
};

/** One run of plain text with its mention chips. Links were cut out by the parser. */
function mentioned(
  body: string,
  { mentions, guest = false, marks, createdAt }: MentionedProps,
): React.ReactNode[] {
  if (!mentions?.length) return [body];
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
    if (at > last) out.push(body.slice(last, at));
    if (marks && !guest && face?.delivery) {
      out.push(
        <MarkedChip
          key={at}
          text={body.slice(at, end)}
          face={face as typeof face & { delivery: DState }}
          p={face}
          guest={guest}
          createdAt={createdAt}
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
  if (last === 0) return [body];
  if (last < body.length) out.push(body.slice(last));
  return out;
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
