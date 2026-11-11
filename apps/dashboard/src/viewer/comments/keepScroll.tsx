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

/** The first thread or comment whose bottom is in view, and where its top sits. */
function pick(box: HTMLElement): Anchor | null {
  const base = box.getBoundingClientRect().top;
  for (const el of box.querySelectorAll("[data-thread], [data-comment]")) {
    const r = el.getBoundingClientRect();
    if (r.bottom > base) return { el, top: r.top - base };
  }
  return null;
}

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
  const anchor = useRef<Anchor | null>(null);
  const seen = useRef(new Set<string>());
  const [pill, setPill] = useState<string | null>(null);
  const record = useCallback(() => {
    const box = scrollerOf(root.current);
    anchor.current = box ? pick(box) : null;
  }, [root]);
  // Every commit: put the remembered element back where it was.
  useLayoutEffect(() => {
    const box = scrollerOf(root.current);
    if (!box) return;
    const a = anchor.current;
    if (a && box.scrollTop > 0 && a.el.isConnected) {
      const base = box.getBoundingClientRect().top;
      const delta = a.el.getBoundingClientRect().top - base - a.top;
      if (delta !== 0) box.scrollTop += delta;
    }
    // A reply that arrived above the reader's view.
    for (const id of tint) {
      if (seen.current.has(id)) continue;
      seen.current.add(id);
      const el = box.querySelector(`[data-comment="${CSS.escape(id)}"]`);
      if (
        el &&
        el.getBoundingClientRect().bottom <= box.getBoundingClientRect().top
      )
        setPill(id);
    }
    record();
  });
  useEffect(() => {
    const box = scrollerOf(root.current);
    if (!box) return;
    const onScroll = () => {
      record();
      setPill((id) => {
        if (!id) return id;
        const el = box.querySelector(`[data-comment="${CSS.escape(id)}"]`);
        return el &&
          el.getBoundingClientRect().bottom > box.getBoundingClientRect().top
          ? null
          : id;
      });
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => box.removeEventListener("scroll", onScroll);
  }, [root, record]);
  const go = () => {
    const box = scrollerOf(root.current);
    const el =
      pill && box?.querySelector(`[data-comment="${CSS.escape(pill)}"]`);
    setPill(null);
    if (!box || !el) return;
    const head = box.querySelector<HTMLElement>("[data-comments-header]");
    const top =
      box.scrollTop +
      el.getBoundingClientRect().top -
      box.getBoundingClientRect().top -
      (head?.offsetHeight ?? 0) -
      8;
    box.scrollTo?.({ top, behavior: reduced() ? "auto" : "smooth" });
    if (!box.scrollTo) box.scrollTop = top;
  };
  return { pill: pill != null, go };
}

export function NewReplyPill({ onClick }: { onClick: () => void }) {
  return (
    <div className="pointer-events-none sticky top-14 z-10 -my-3 flex h-0 justify-center">
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
