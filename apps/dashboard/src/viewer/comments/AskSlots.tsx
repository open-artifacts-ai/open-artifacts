import { ASK_SLOT_H_MAX, viewerPath } from "@oa/shared";
import { useEffect, useLayoutEffect, useRef } from "react";
import { type AskSlot, useAskSlots } from "../../api/askSlots";
import type { AskSlotRect } from "../bridge";
import { TXT } from "../ui";
import { askedWho } from "./asks";
import { optionIdOf, textOf } from "./ownWords";
import { useCommentsApi } from "./useComments";

const MUTED = "text-muted-foreground";
/** A slot narrower than this still gets a card this wide; the frame bounds the rest. */
const MIN_W = 240;
const MAX_W = 640;

/** A withdrawn or replaced ask has no card: its slot closes up (#2511). */
export const slotGone = (s: AskSlot) => !!s.ask.withdrawn || !!s.ask.replacedBy;

/** Where a card goes inside the frame's box, always within it. */
export function slotPlace(
  rect: AskSlotRect,
  frame: { w: number; h: number },
  cardH: number,
) {
  const w = Math.max(
    Math.min(frame.w, MIN_W),
    Math.min(rect.width || MIN_W, MAX_W, frame.w),
  );
  const x = Math.min(Math.max(0, rect.x), Math.max(0, frame.w - w));
  // Only a card with no part in the visible frame is hidden.
  const visible = rect.y + cardH > 0 && rect.y < frame.h && frame.w > 0;
  return { x, y: rect.y, w, visible };
}

/** The thread a slot's ask lives on, and who asked it. */
function askThread(s: AskSlot): { id: string; author: string } {
  return { id: s.threadId, author: s.author?.name ?? "An agent" };
}

function decisionText(s: AskSlot): string | null {
  const a = s.ask;
  if (!a.closed || !a.answer) return null;
  const words = textOf(a.answer);
  if (words) return words;
  const id = optionIdOf(a.answer);
  return a.options.find((o) => o.id === id)?.label ?? null;
}

function AskSlotCard({
  slot,
  rect,
  frame,
  here,
  onSize,
}: {
  slot: AskSlot;
  rect: AskSlotRect;
  frame: HTMLElement;
  /** True when the ask lives on this page. */
  here: boolean;
  onSize: (key: string, h: number) => void;
}) {
  const api = useCommentsApi();
  const ref = useRef<HTMLDivElement>(null);
  const { key } = slot;
  // The height the page's slot needs: the card and its note, as drawn.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `onSize` is stable per mount
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      onSize(key, Math.min(ASK_SLOT_H_MAX, Math.ceil(el.offsetHeight)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [key]);
  const place = slotPlace(
    rect,
    { w: frame.clientWidth, h: frame.clientHeight },
    ref.current?.offsetHeight ?? 0,
  );
  const px = Math.round(place.x);
  const py = Math.round(place.y);
  const pw = Math.round(place.w);
  const thread = askThread(slot);
  const decided = decisionText(slot);
  const home = slot.home;
  const who = slot.ask.to.some((a) => a.me) || slot.ask.role !== undefined;
  const from = `${thread.author} asks${askedWho(slot.ask.to, who)}`;
  // #3048: an ask opens its thread in the comments; the card in the page is a
  // summary that says one is there. Answering happens in the thread.
  const body = (
    <>
      <span className={`block ${TXT} ${MUTED}`}>
        {from}
        {!here && (
          <>
            {" · from "}
            <a
              href={viewerPath(home.artifactId)}
              target="_blank"
              rel="noopener"
              className="underline underline-offset-2"
            >
              {home.title} ↗
            </a>
          </>
        )}
      </span>
      <span className={`block ${TXT} font-medium break-words`}>
        {slot.ask.question}
      </span>
      {decided !== null && (
        <span
          data-ask-slot-decided=""
          className={`block ${TXT} font-medium text-[var(--oa-success-fg)]`}
        >
          ✓ Decided: {decided}
        </span>
      )}
      {here && decided === null && (
        <span className={`block ${TXT} ${MUTED}`}>
          Open the thread to answer.
        </span>
      )}
    </>
  );
  return (
    <div
      ref={ref}
      data-ask-slot={key}
      data-oa-keep-selection=""
      style={{
        left: px,
        top: py,
        width: pw,
        visibility: place.visible ? "visible" : "hidden",
        pointerEvents: place.visible ? "auto" : "none",
        maxHeight: ASK_SLOT_H_MAX,
      }}
      className="absolute flex flex-col gap-1.5 overflow-y-auto"
    >
      <section
        aria-label="Ask"
        className="rounded-xl border border-border bg-card p-3 shadow-sm"
      >
        {here ? (
          <button
            type="button"
            data-ask-slot-open=""
            onClick={() => api.onOpen(thread.id)}
            className="block w-full cursor-pointer border-0 bg-transparent p-0 text-left"
          >
            {body}
          </button>
        ) : (
          <>
            {body}
            <p className={`mb-0 ${TXT}`}>
              <a
                href={`${viewerPath(home.artifactId)}?thread=${encodeURIComponent(slot.threadId)}`}
                target="_blank"
                rel="noopener"
                data-ask-slot-context=""
                className="underline underline-offset-2"
              >
                See it in context
              </a>
            </p>
          </>
        )}
      </section>
      {slot.note && (
        <p data-ask-slot-note="" className={`m-0 px-1 ${TXT} ${MUTED}`}>
          Note from {slot.placer?.name ?? "someone"}, who put this here:{" "}
          {slot.note}
        </p>
      )}
    </div>
  );
}

/**
 * #2426 B: the cards for the page's `[data-oa-ask]` slots, drawn here over the
 * frame, never inside the sandbox. A card exists only for a key the frame
 * reported and the server has an ask for; every other reported key is told
 * h 0 and closes up. A card is a summary: clicking it opens the thread in the
 * comments (#3048), where the answer goes. It is clamped into the frame and
 * hidden while its slot is off-screen.
 */
export function AskSlots({
  frame,
  artifactId,
  reported,
  setSize,
  enabled = true,
}: {
  frame: HTMLElement | null;
  artifactId: string;
  reported: { key: string; rect: AskSlotRect }[];
  setSize: (key: string, h: number) => void;
  enabled?: boolean;
}) {
  const q = useAskSlots(artifactId, enabled && reported.length > 0);
  const settled = q.isSuccess || q.isError;
  const known = new Map(
    (q.data ?? []).filter((s) => !slotGone(s)).map((s) => [s.key, s]),
  );
  // Sent heights by key, so a repeat is not sent again; a new frame starts over.
  const sent = useRef(new Map<string, number>());
  const send = (key: string, h: number) => {
    if (sent.current.get(key) === h) return;
    sent.current.set(key, h);
    setSize(key, h);
  };
  const sendRef = useRef(send);
  sendRef.current = send;
  const keys = reported.map((r) => r.key).join(",");
  const knownKeys = [...known.keys()].join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key lists are the trigger
  useEffect(() => {
    if (reported.length === 0) sent.current.clear();
    if (!settled) return;
    for (const r of reported) if (!known.has(r.key)) sendRef.current(r.key, 0);
  }, [keys, knownKeys, settled]);
  // A slot that is no longer known must be sendable again if it comes back.
  const stable = useRef(sendRef);
  stable.current = sendRef;
  const onSize = useRef((key: string, h: number) =>
    stable.current.current(key, h),
  ).current;
  if (!frame || !settled) return null;
  return (
    <div
      data-ask-slots=""
      style={{
        left: frame.offsetLeft,
        top: frame.offsetTop,
        width: frame.clientWidth,
        height: frame.clientHeight,
      }}
      className="pointer-events-none absolute z-20 overflow-hidden"
    >
      {reported.map((r) => {
        const s = known.get(r.key);
        return s ? (
          <AskSlotCard
            key={r.key}
            slot={s}
            rect={r.rect}
            frame={frame}
            here={s.home.artifactId === artifactId}
            onSize={onSize}
          />
        ) : null;
      })}
    </div>
  );
}
