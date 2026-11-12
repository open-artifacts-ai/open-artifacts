import type { ArtifactAgent } from "@oa/shared";
import { type RefObject, useLayoutEffect, useRef } from "react";
import { mentionSegments } from "./asks";

/** Style the mirror copies from the textarea so both wrap the same way. */
const COPIED = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariantLigatures",
  "fontKerning",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textTransform",
  "textIndent",
  "tabSize",
  "direction",
  "whiteSpace",
  "overflowWrap",
  "wordBreak",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderRightWidth",
] as const;

/**
 * #2317: an aria-hidden layer behind the comment box. It repeats the text with
 * the box's own metrics, transparent, and paints only the pill behind each
 * @name that will notify someone. The textarea stays the source of truth for
 * typing, IME and screen readers; this layer never takes input.
 */
export function MentionMirror({
  field,
  text,
  agents,
}: {
  field: RefObject<HTMLTextAreaElement | null>;
  text: string;
  agents: readonly ArtifactAgent[];
}) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);

  const sync = useRef(() => {});
  sync.current = () => {
    const ta = field.current;
    const b = box.current;
    const i = inner.current;
    if (!ta || !b || !i) return;
    const cs = getComputedStyle(ta);
    for (const k of COPIED) b.style[k] = cs[k];
    // Match the content box, scrollbar included.
    const bar =
      ta.offsetWidth -
      ta.clientWidth -
      (Number.parseFloat(cs.borderLeftWidth) || 0) -
      (Number.parseFloat(cs.borderRightWidth) || 0);
    b.style.width = `${ta.offsetWidth}px`;
    b.style.paddingRight = `${(Number.parseFloat(cs.paddingRight) || 0) + Math.max(0, bar)}px`;
    i.style.transform = `translateY(${-ta.scrollTop}px)`;
  };

  // Every render: the text, or a field-sizing change, may move the lines.
  useLayoutEffect(() => {
    sync.current();
  });

  useLayoutEffect(() => {
    const ta = field.current;
    if (!ta) return;
    const run = () => sync.current();
    ta.addEventListener("scroll", run, { passive: true });
    ta.addEventListener("input", run);
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(run);
      ro.observe(ta);
    }
    let live = true;
    document.fonts?.ready.then(() => live && run());
    window.addEventListener("resize", run);
    return () => {
      live = false;
      ta.removeEventListener("scroll", run);
      ta.removeEventListener("input", run);
      window.removeEventListener("resize", run);
      ro?.disconnect();
    };
  }, [field]);

  const segs = mentionSegments(text, agents);
  return (
    <div
      ref={box}
      aria-hidden="true"
      data-oa-mirror=""
      className="pointer-events-none absolute top-0 left-0 z-0 box-border h-full overflow-hidden border-transparent border-solid text-transparent"
    >
      <div ref={inner} data-oa-mirror-inner="">
        {segs.map((s, n) =>
          s.key ? (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
              key={n}
              data-oa-pill=""
              className="rounded-[0.4em] bg-[var(--oa-accent-soft)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--oa-accent-fg)_30%,transparent)] [box-decoration-break:clone]"
            >
              {s.text}
            </span>
          ) : (
            s.text
          ),
        )}
        {/* A trailing newline needs a character to open its line. */}
        {"​"}
      </div>
    </div>
  );
}
