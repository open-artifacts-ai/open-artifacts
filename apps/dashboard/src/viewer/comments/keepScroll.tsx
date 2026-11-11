import { Button } from "@oa/ui/shadcn";
import { ArrowDown, ArrowUp } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** The nearest ancestor that scrolls: the column, the side panel or the sheet. */
export function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if (o === "auto" || o === "scroll") return n;
  }
  return null;
}

const reduced = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** An element and its top in the scroller's content (independent of scrollTop). */
type Anchor = { el: Element; at: number };

const headOf = (box: HTMLElement) =>
  box.querySelector<HTMLElement>("[data-comments-header]");

/** The phone sheet's floating action row, stuck to the scroller's bottom. */
const footOf = (box: HTMLElement) =>
  box.querySelector<HTMLElement>("[data-oa-action-outlet]")?.offsetHeight ?? 0;

/** Where the scroller's visible area starts: under the sticky header. */
const viewTop = (box: HTMLElement) =>
  box.getBoundingClientRect().top + (headOf(box)?.offsetHeight ?? 0);

const contentTop = (box: HTMLElement, el: Element) =>
  el.getBoundingClientRect().top -
  box.getBoundingClientRect().top +
  box.scrollTop;

/**
 * The first comment, and the first thread, whose bottom is in view. A comment
 * is the finer anchor; its thread is the fallback when the comment is gone.
 */
function pick(box: HTMLElement): Anchor[] {
  const base = box.getBoundingClientRect().top;
  const out: Anchor[] = [];
  for (const sel of ["[data-comment]", "[data-thread]"]) {
    for (const el of box.querySelectorAll(sel)) {
      if (el.getBoundingClientRect().bottom > base) {
        out.push({ el, at: contentTop(box, el) });
        break;
      }
    }
  }
  return out;
}

const row = (box: HTMLElement, id: string) =>
  box.querySelector<HTMLElement>(`[data-comment="${CSS.escape(id)}"]`);

export type PillDir = "up" | "down";

/**
 * #2179: content that appears above the reader never moves what they read.
 * The panel's own scrollTop is adjusted (the document is never scrolled).
 * The newest reply that arrived live gets a "New reply" pill while it is
 * outside the panel's visible area (an IntersectionObserver rooted on the
 * scroller, below the sticky header); the pill points the way, scrolls the
 * panel to the reply and moves focus there. Browser scroll anchoring is off
 * on the list so the two never both correct.
 */
export function useKeepScroll(
  root: React.RefObject<HTMLElement | null>,
  arrived: readonly string[],
) {
  const scroller = useRef<HTMLElement | null>(null);
  // The same scroller as state: the IntersectionObserver re-roots on a swap.
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
  const anchors = useRef<Anchor[]>([]);
  const [target, setTarget] = useState<string | null>(null);
  const [dir, setDir] = useState<PillDir | null>(null);
  // The floating action row's height: a down pill sits above it.
  const [foot, setFoot] = useState(0);
  const record = useCallback(() => {
    const box = scroller.current;
    anchors.current = box ? pick(box) : [];
  }, []);
  /** Adopts `box` as the scroller and gives it the header's scroll padding. */
  const adopt = useCallback((box: HTMLElement | null) => {
    if (box !== scroller.current) {
      if (scroller.current) scroller.current.style.scrollPaddingTop = "";
      scroller.current = box;
      setScrollerEl(box);
    }
    // The sticky header covers the scroller's top: scrolled-to elements (a
    // pin's card, Shift+Tab) stop below it.
    const head = box && headOf(box);
    if (!box || !head) return;
    const pad = `${head.offsetHeight}px`;
    if (box.style.scrollPaddingTop !== pad) box.style.scrollPaddingTop = pad;
  }, []);
  // Every commit: find the scroller again (column, panel or sheet), and put
  // the remembered element back where it was in the content. A held element
  // (holdAnchor: the thread whose "Show N earlier replies" was pressed) wins
  // for that commit, so the replies it reveals open below its top.
  useLayoutEffect(() => {
    const box = scrollerOf(root.current);
    adopt(box);
    if (!box) return;
    const held = box.querySelector<HTMLElement>("[data-hold-top]");
    if (held) {
      const delta =
        held.getBoundingClientRect().top - Number(held.dataset.holdTop);
      delete held.dataset.holdTop;
      if (delta !== 0) box.scrollTop += delta;
    } else {
      const a = anchors.current.find((a) => a.el.isConnected);
      if (a && box.scrollTop > 0) {
        const delta = contentTop(box, a.el) - a.at;
        if (delta !== 0) box.scrollTop += delta;
      }
    }
    record();
  });
  // A scroller that only becomes one after the first commit (the side
  // panel's ScrollArea viewport is overflow-hidden until Radix measures):
  // look again for up to a second of frames.
  useEffect(() => {
    if (scroller.current) return;
    let frame = 0;
    let tries = 0;
    const look = () => {
      const box = scrollerOf(root.current);
      if (box) {
        adopt(box);
        record();
      } else if (++tries < 60) frame = requestAnimationFrame(look);
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [root, adopt, record]);
  useEffect(
    () => () => {
      if (scroller.current) scroller.current.style.scrollPaddingTop = "";
    },
    [],
  );
  // Capture on the document: scroll doesn't bubble. The cached scroller
  // counts; another element is looked at only if it holds the list (a panel
  // that became the scroller since the last commit).
  useEffect(() => {
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t !== scroller.current) {
        if (!(t instanceof HTMLElement) || !t.contains(root.current)) return;
        if (scrollerOf(root.current) !== t) return;
        adopt(t);
      }
      record();
    };
    document.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    return () =>
      document.removeEventListener("scroll", onScroll, { capture: true });
  }, [root, adopt, record]);
  // The newest arrival is the pill's target until it is seen.
  const newest = arrived.at(-1) ?? null;
  useEffect(() => {
    setTarget(newest);
    setDir(null);
  }, [newest]);
  useEffect(() => {
    const box = scrollerEl;
    const el = target && box ? row(box, target) : null;
    if (!box || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e) return;
        if (e.isIntersecting) {
          setTarget(null);
          setDir(null);
          return;
        }
        const top = e.rootBounds?.top ?? viewTop(box);
        setFoot(footOf(box));
        setDir(e.boundingClientRect.bottom <= top ? "up" : "down");
      },
      {
        root: box,
        // Under the sticky header or the floating action row is not in view.
        rootMargin: `-${headOf(box)?.offsetHeight ?? 0}px 0px -${footOf(box)}px 0px`,
      },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [target, scrollerEl]);
  const go = () => {
    const box = scroller.current;
    const el = target && box ? row(box, target) : null;
    setTarget(null);
    setDir(null);
    if (!box || !el) return;
    const top =
      box.scrollTop + el.getBoundingClientRect().top - viewTop(box) - 8;
    if (box.scrollTo) {
      box.scrollTo({ top, behavior: reduced() ? "auto" : "smooth" });
    } else box.scrollTop = top;
    // The pill unmounts with focus on it: hand focus to the reply.
    focusRow(el);
    // The pill's removal commits before any scroll event: re-anchor now, or
    // that commit would undo this scroll.
    record();
  };
  return { pill: target && dir ? dir : null, foot, go };
}

/** Focuses a comment row without scrolling anything. */
export function focusRow(el: HTMLElement) {
  if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
  el.focus({ preventScroll: true });
}

/**
 * Keeps `el`'s top where it is through the next commit (useKeepScroll reads
 * it): content it reveals opens below it, not above the reader.
 */
export function holdAnchor(el: HTMLElement | null) {
  if (el) el.dataset.holdTop = String(el.getBoundingClientRect().top);
}

export function NewReplyPill({
  dir,
  foot = 0,
  onClick,
  under,
}: {
  dir: PillDir;
  /** A down pill's clearance: the floating action row below it. */
  foot?: number;
  onClick: () => void;
  /** The panel's own sticky header is above it in the scroller. */
  under: boolean;
}) {
  const Icon = dir === "up" ? ArrowUp : ArrowDown;
  return (
    <div
      data-pill-dir={dir}
      className={`pointer-events-none sticky z-10 flex h-0 justify-center ${
        dir === "up"
          ? `${under ? "top-14" : "top-2"} -mb-3 items-start`
          : "-mt-3 items-end"
      }`}
      style={dir === "down" ? { bottom: foot + 12 } : undefined}
    >
      <Button
        size="xs"
        data-new-reply=""
        className="pointer-events-auto rounded-full shadow-md"
        onClick={onClick}
      >
        <Icon aria-hidden="true" />
        New reply
      </Button>
    </div>
  );
}
