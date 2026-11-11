import { Button } from "@oa/ui/shadcn";
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

type Anchor = { el: Element; top: number };

/** Where the scroller's visible area starts: under the sticky header. */
function viewTop(box: HTMLElement): number {
  const head = box.querySelector<HTMLElement>("[data-comments-header]");
  return box.getBoundingClientRect().top + (head?.offsetHeight ?? 0);
}

/**
 * The first comment, and the first thread, whose bottom is in view, and where
 * their tops sit. A comment is the finer anchor; its thread is the fallback
 * when the comment folds away.
 */
function pick(box: HTMLElement): Anchor[] {
  const base = box.getBoundingClientRect().top;
  const out: Anchor[] = [];
  for (const sel of ["[data-comment]", "[data-thread]"]) {
    for (const el of box.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.bottom > base) {
        out.push({ el, top: r.top - base });
        break;
      }
    }
  }
  return out;
}

const row = (box: HTMLElement, id: string) =>
  box.querySelector(`[data-comment="${CSS.escape(id)}"]`);

/**
 * #2179: content that appears above the reader never moves what they read.
 * The panel's own scrollTop is adjusted (the document is never scrolled), and
 * a reply that landed out of view above gets a "New reply" pill that scrolls
 * the panel to it. Browser scroll anchoring is off on the list so the two
 * never both correct.
 */
export function useKeepScroll(
  root: React.RefObject<HTMLElement | null>,
  tint: ReadonlySet<string>,
) {
  const anchors = useRef<Anchor[]>([]);
  const seen = useRef(new Set<string>());
  const [pill, setPill] = useState<string | null>(null);
  const record = useCallback(() => {
    const box = scrollerOf(root.current);
    anchors.current = box ? pick(box) : [];
  }, [root]);
  // Every commit: put the remembered element back where it was.
  useLayoutEffect(() => {
    const box = scrollerOf(root.current);
    if (!box) return;
    const a = anchors.current.find((a) => a.el.isConnected);
    if (a && box.scrollTop > 0) {
      const base = box.getBoundingClientRect().top;
      const delta = a.el.getBoundingClientRect().top - base - a.top;
      if (delta !== 0) box.scrollTop += delta;
    }
    // A reply that arrived above the reader's view.
    for (const id of tint) {
      if (seen.current.has(id)) continue;
      seen.current.add(id);
      const el = row(box, id);
      if (el && el.getBoundingClientRect().bottom <= viewTop(box)) setPill(id);
    }
    record();
  });
  // Capture on the document: the scroller may only start scrolling (or be
  // swapped, column to sheet) after this mounts.
  useEffect(() => {
    const onScroll = (e: Event) => {
      const box = scrollerOf(root.current);
      if (!box || e.target !== box) return;
      record();
      setPill((id) => {
        if (!id) return id;
        const el = row(box, id);
        return el && el.getBoundingClientRect().bottom > viewTop(box)
          ? null
          : id;
      });
    };
    document.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    return () =>
      document.removeEventListener("scroll", onScroll, { capture: true });
  }, [root, record]);
  const go = () => {
    const box = scrollerOf(root.current);
    const el = pill && box ? row(box, pill) : null;
    setPill(null);
    if (!box || !el) return;
    const top =
      box.scrollTop + el.getBoundingClientRect().top - viewTop(box) - 8;
    if (box.scrollTo) {
      box.scrollTo({ top, behavior: reduced() ? "auto" : "smooth" });
    } else box.scrollTop = top;
    // The pill's removal commits before any scroll event: re-anchor now, or
    // that commit would undo this scroll.
    record();
  };
  return { pill: pill != null, go };
}

/** `under`: the panel's own sticky header is above it in the scroller. */
export function NewReplyPill({
  onClick,
  under,
}: {
  onClick: () => void;
  under: boolean;
}) {
  return (
    <div
      className={`pointer-events-none sticky ${under ? "top-14" : "top-2"} z-10 -my-3 flex h-0 justify-center`}
    >
      <Button
        size="xs"
        data-new-reply=""
        className="pointer-events-auto rounded-full shadow-md"
        onClick={onClick}
      >
        New reply
      </Button>
    </div>
  );
}
