import type { CommentThread } from "@oa/shared";
import { ArrowLeft, Check, ShieldCheck } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { CTXT, TXT } from "../ui";
import { versionDate } from "../versionDate";
import { AuthorFace } from "./AuthorFace";
import { type Decision, weighIns } from "./decisionsModel";
import { FaceStack } from "./FaceStack";
import { scrollWithin } from "./keepScroll";
import type { CommentsApi } from "./useComments";

const MUTED = "text-muted-foreground";

/** The nearest ancestor that scrolls (the column, the panel's viewport or the sheet). */
function scroller(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if (o === "auto" || o === "scroll") return n;
  }
  return null;
}

/**
 * #2381 S2: the pane's two tabs. Under 960px in the side panel they are the
 * panel's own tab row instead (SidePanel), so this is the wide header.
 */
export function CommentsTabs({
  api,
  className = "",
}: {
  api: CommentsApi;
  className?: string;
}) {
  const tabs = [
    {
      id: "comments" as const,
      label: "Comments",
      n: api.listedOpen,
    },
    { id: "decisions" as const, label: "Decisions", n: api.decisions.length },
  ];
  const go = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = api.view === "comments" ? "decisions" : "comments";
    api.setView(next);
    // Focus follows the selection (roving tabindex).
    queueMicrotask(() =>
      e.currentTarget.parentElement
        ?.querySelector<HTMLElement>(`[data-tab="${next}"]`)
        ?.focus({ preventScroll: true }),
    );
  };
  return (
    <div
      role="tablist"
      aria-label="Comments and decisions"
      data-comments-tabs=""
      className={`flex items-end gap-4 ${className}`}
    >
      {tabs.map((t) => {
        const on = api.view === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`oa-tab-${t.id}`}
            data-tab={t.id}
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onKeyDown={go}
            onClick={() => {
              api.setView(t.id);
              api.setOpenDecision(null);
            }}
            className={`-mb-px cursor-pointer border-0 border-b-2 bg-transparent px-0 pb-1.5 font-semibold ${CTXT} focus-visible:outline-2 focus-visible:outline-[var(--oa-focus)] ${
              on
                ? "border-b-[var(--oa-accent)] text-foreground"
                : `border-b-transparent ${MUTED}`
            }`}
          >
            {t.label}
            <span
              aria-hidden="true"
              className={`ml-1.5 font-normal ${MUTED}`}
              data-tab-count=""
            >
              {api.loading ? "·" : t.n}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const Pill = ({
  children,
  tone = "neutral",
  ...rest
}: {
  children: ReactNode;
  tone?: "neutral" | "ok";
} & Record<string, unknown>) => (
  <span
    {...rest}
    className={`inline-flex w-fit items-center gap-1 rounded px-1.5 ${TXT} font-semibold ${
      tone === "ok"
        ? "bg-[var(--oa-success-soft)] text-[var(--oa-success-fg)]"
        : "bg-muted text-muted-foreground"
    }`}
  >
    {children}
  </span>
);

function Row({
  d,
  all,
  onOpen,
}: {
  d: Decision;
  all: readonly Decision[];
  onOpen: () => void;
}) {
  const { ask, answer, comment, thread } = d;
  const opt = ask.options.find((o) => o.id === answer.optionId);
  const was = answer.was
    ? ask.options.find((o) => o.id === answer.was?.optionId)
    : undefined;
  const w = weighIns(d);
  const replacedBy = ask.replacedBy
    ? all.find((x) => x.id === ask.replacedBy)
    : undefined;
  const replaced = ask.replacedBy !== undefined;
  const chips: ReactNode[] = [];
  if (thread.status === "resolved")
    chips.push(
      <Pill key="resolved" data-chip="resolved">
        Thread resolved
      </Pill>,
    );
  if (answer.verified === "passkey")
    chips.push(
      <Pill key="verified" tone="ok" data-chip="verified">
        <ShieldCheck aria-hidden="true" className="size-3" />
        Verified with passkey
      </Pill>,
    );
  if (answer.was)
    chips.push(
      <Pill key="changed" data-chip="changed">
        Changed {versionDate(answer.at)}
      </Pill>,
    );
  const by = answer.by;
  // One " · " between every part of the meta line.
  const parts: { key: string; el: ReactNode }[] = [
    {
      key: "by",
      el: (
        <span className="inline-flex items-center gap-1.5">
          <FaceStack
            faces={[
              {
                key: String(by.id ?? by.name),
                round: by.kind !== "agent",
                el: <AuthorFace a={by} small />,
              },
            ]}
          />
          {by.me ? "You decided" : `${by.name} decided`}
        </span>
      ),
    },
    ...(w.n > 0
      ? [
          {
            key: "n",
            el: <span data-weighed="">{w.n} weighed in</span>,
          },
        ]
      : []),
    ...(w.differed > 0
      ? [{ key: "d", el: <span>{w.differed} differed</span> }]
      : []),
    { key: "at", el: <span>{versionDate(answer.at)}</span> },
    { key: "asker", el: <span>Asked by {comment.author.name}</span> },
    ...(answer.was
      ? [
          {
            key: "was",
            el: (
              <span data-was="">
                Was: {was?.label ?? answer.was.optionId},{" "}
                {versionDate(answer.was.at)}
              </span>
            ),
          },
        ]
      : []),
  ];
  return (
    <li
      data-decision={d.id}
      className="relative flex flex-col gap-1 rounded-md border border-border p-3 hover:bg-muted/40"
    >
      {replaced && (
        // Its own link, above the row's stretched button: no link inside a button.
        <span className="relative z-10 flex">
          {replacedBy ? (
            <a
              href={`#decision-${replacedBy.id}`}
              data-chip="replaced"
              onClick={(e) => {
                e.preventDefault();
                const to = document.querySelector<HTMLElement>(
                  `[data-decision="${CSS.escape(replacedBy.id)}"]`,
                );
                if (to) scrollWithin(to, "nearest");
                to?.querySelector<HTMLElement>("button")?.focus({
                  preventScroll: true,
                });
              }}
              className={`inline-flex w-fit rounded bg-muted px-1.5 ${TXT} font-semibold text-muted-foreground underline underline-offset-2`}
            >
              Replaced
            </a>
          ) : (
            <Pill data-chip="replaced">Replaced</Pill>
          )}
        </span>
      )}
      <p className={`m-0 ${TXT} ${MUTED} break-words`}>{ask.question}</p>
      <button
        type="button"
        onClick={onOpen}
        className={`flex cursor-pointer items-start gap-1.5 border-0 bg-transparent p-0 text-left font-semibold text-foreground after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-[var(--oa-focus)] ${CTXT}`}
      >
        <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span
          className={`min-w-0 break-words ${replaced ? "line-through" : ""}`}
        >
          {opt?.label ?? answer.optionId}
        </span>
      </button>
      <p
        data-decision-meta=""
        className={`m-0 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 ${TXT} ${MUTED}`}
      >
        {parts.map((part, i) => (
          <Fragment key={part.key}>
            {i > 0 && <span aria-hidden="true">{" · "}</span>}
            {part.el}
          </Fragment>
        ))}
      </p>
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">{chips}</div>
      )}
    </li>
  );
}

/**
 * #2381 S2: the decided asks of the page, newest first. A row opens its thread
 * in place (resolved ones included) under a "← Decisions" row; back returns to
 * the same scroll position.
 */
export function DecisionsView({
  api,
  renderThread,
}: {
  api: CommentsApi;
  renderThread: (t: CommentThread) => ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const saved = useRef<number | null>(null);
  const open = api.openDecision
    ? api.threads.find((t) => t.id === api.openDecision)
    : undefined;
  // Back: the list is back in the DOM; put the scroll where it was.
  useLayoutEffect(() => {
    if (open || saved.current === null) return;
    const s = scroller(root.current);
    if (s) s.scrollTop = saved.current;
    saved.current = null;
  }, [open]);
  const all = api.decisions;
  const gone = api.openDecision !== null && !open;
  // The thread is gone (deleted elsewhere): back to the list.
  useEffect(() => {
    if (gone) api.setOpenDecision(null);
  }, [gone, api.setOpenDecision]);
  if (open)
    return (
      <div ref={root} className="flex flex-col gap-3" data-decision-thread="">
        <button
          type="button"
          onClick={() => api.setOpenDecision(null)}
          className={`flex w-fit cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-medium text-foreground ${TXT} focus-visible:outline-2 focus-visible:outline-[var(--oa-focus)]`}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Decisions
        </button>
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {renderThread(open)}
        </ul>
      </div>
    );
  if (all.length === 0)
    return (
      <div ref={root} data-decisions-empty="" className="flex flex-col gap-1">
        <p className={`m-0 font-semibold ${CTXT}`}>No decisions yet</p>
        <p className={`m-0 ${TXT} ${MUTED}`}>
          When an ask on this page is answered, the decision stays here.
        </p>
      </div>
    );
  return (
    <div ref={root}>
      <ul
        aria-label="Decisions"
        className="m-0 flex list-none flex-col gap-3 p-0"
      >
        {all.map((d) => (
          <Row
            key={d.id}
            d={d}
            all={all}
            onOpen={() => {
              const s = scroller(root.current);
              saved.current = s ? s.scrollTop : null;
              api.setOpenDecision(d.thread.id);
            }}
          />
        ))}
      </ul>
    </div>
  );
}
