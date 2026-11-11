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
  const anchors = useRef<Anchor[]>([]);
  const [target, setTarget] = useState<string | null>(null);
  const [dir, setDir] = useState<PillDir | null>(null);
  const record = useCallback(() => {
    const box = scroller.current;
    anchors.current = box ? pick(box) : [];
  }, []);
  // Every commit: find the scroller again (column, panel or sheet), and put
  // the remembered element back where it was in the content.
  useLayoutEffect(() => {
    const box = scrollerOf(root.current);
    scroller.current = box;
    if (!box) return;
    const a = anchors.current.find((a) => a.el.isConnected);
    if (a && box.scrollTop > 0) {
      const delta = contentTop(box, a.el) - a.at;
      if (delta !== 0) box.scrollTop += delta;
    }
    record();
  });
  // The sticky header covers the scroller's top: scrolled-to elements (a
  // pin's card, Shift+Tab) stop below it. Checked on every commit, so a
  // scroller swapped in later gets it too; cleared on unmount.
  useLayoutEffect(() => {
    const box = scroller.current;
    const head = box && headOf(box);
    if (!box || !head) return;
    const pad = `${head.offsetHeight}px`;
    if (box.style.scrollPaddingTop !== pad) box.style.scrollPaddingTop = pad;
  });
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
        scroller.current = t;
      }
      record();
    };
    document.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    return () =>
      document.removeEventListener("scroll", onScroll, { capture: true });
  }, [root, record]);
  // The newest arrival is the pill's target until it is seen.
  const newest = arrived.at(-1) ?? null;
  useEffect(() => {
    setTarget(newest);
    setDir(null);
  }, [newest]);
  useEffect(() => {
    const box = scroller.current;
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
        setDir(e.boundingClientRect.bottom <= top ? "up" : "down");
      },
      {
        root: box,
        rootMargin: `-${headOf(box)?.offsetHeight ?? 0}px 0px 0px 0px`,
      },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [target]);
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
    if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
    el.focus({ preventScroll: true });
    // The pill's removal commits before any scroll event: re-anchor now, or
    // that commit would undo this scroll.
    record();
  };
  return { pill: target && dir ? dir : null, go };
}

export function NewReplyPill({
  dir,
  onClick,
  under,
}: {
  dir: PillDir;
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
          : "bottom-3 -mt-3 items-end"
      }`}
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
