import type { Comment as CommentT, CommentThread } from "@oa/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AskBlock } from "./asks";
import { besideWidth, placeBeside } from "./pinPlacement";
import { useCommentsApi } from "./useComments";

/** How long the card's options stay inert after it opens or moves (clickjacking, #2426). */
export const ASK_INERT_MS = 600;
/** The card may drift this far (px) before its options go inert again. */
export const ASK_MOVE_PX = 4;

/**
 * #2426: the ask card beside an anchored ask's marker. Drawn by the shell, over
 * the sandboxed frame and never inside it, so the page cannot draw or click the
 * buttons that count. `comment.open` and `at` come from page code and can be
 * forged, so: the point is clamped into the frame (the card never covers shell
 * chrome), and the options are inert for 600 ms after the card opens or jumps
 * more than a few pixels, and ignore a press that began before the card
 * appeared (a page cannot slide the card under a click already in flight).
 */
export function AskBeside({ frame }: { frame: HTMLElement | null }) {
  const api = useCommentsApi();
  const id = api.askCard;
  const at = api.askAt;
  const thread: CommentThread | undefined = id
    ? api.threads.find((t) => t.id === id)
    : undefined;
  const c: CommentT | undefined =
    thread?.comments.find((x) => x.ask?.role !== undefined && x.ask) ??
    thread?.comments.find((x) => x.ask);
  const ref = useRef<HTMLElement>(null);
  const [h, setH] = useState(220);
  const [armed, setArmed] = useState(false);
  // Where the card was when it armed.
  const anchor = useRef<{ x: number; y: number } | null>(null);
  // Whether a press on the card began while it was armed: a press that began before it showed, or while it was inert, never counts.
  const armedRef = useRef(false);
  armedRef.current = armed;
  const pressed = useRef(false);
  const shown = !!(id && thread && c && frame && at);

  // Inert for ASK_INERT_MS after it opens, and again whenever it jumps.
  useEffect(() => {
    if (!shown || !at) {
      setArmed(false);
      anchor.current = null;
      return;
    }
    const a = anchor.current;
    if (a && Math.hypot(a.x - at.x, a.y - at.y) <= ASK_MOVE_PX) return;
    anchor.current = { x: at.x, y: at.y };
    setArmed(false);
    const t = setTimeout(() => setArmed(true), ASK_INERT_MS);
    return () => clearTimeout(t);
  }, [shown, at]);

  // The card grows (a passkey line, the options): keep it in view at its real height.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => el.offsetHeight && setH(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shown]);

  useEffect(() => {
    if (!id) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) api.setAskCard(null);
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [id, api.setAskCard]);

  if (!shown || !frame || !at || !thread || !c) return null;
  const fw = frame.clientWidth;
  const fh = frame.clientHeight;
  // Clamp the page's point into the frame: the card is placed inside it, never over shell chrome.
  const point = {
    x: Math.max(0, Math.min(at.x, fw)),
    y: Math.max(0, Math.min(at.y, fh)),
  };
  const w = besideWidth(fw);
  const { left, top } = placeBeside(point, { w: fw, h: fh }, { w, h });
  return (
    <section
      ref={ref}
      aria-label="Ask"
      data-oa-keep-selection=""
      data-ask-beside=""
      data-armed={armed ? "" : undefined}
      style={{
        left: frame.offsetLeft + left,
        top: frame.offsetTop + top,
        width: w,
        // Inert until armed: a click passes through to the page, nothing on the card takes it.
        pointerEvents: armed ? undefined : "none",
      }}
      className="absolute z-20 max-h-[calc(100%-16px)] overflow-y-auto rounded-xl border border-[var(--oa-warning)] bg-card p-2 shadow-xl"
      onPointerDownCapture={() => {
        pressed.current = armedRef.current;
      }}
      onClickCapture={(e) => {
        // A pointer click needs its own press on this armed card; a keyboard activation (detail 0) is fine.
        if (e.detail !== 0 && !pressed.current) {
          e.stopPropagation();
          e.preventDefault();
        }
        pressed.current = false;
      }}
    >
      <AskBlock
        artifactId={api.artifactId}
        thread={thread}
        c={c}
        guest={api.guest}
      />
    </section>
  );
}
