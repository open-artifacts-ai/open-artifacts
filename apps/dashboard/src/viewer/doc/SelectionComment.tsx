import { Button } from "@oa/ui/shadcn";
import { MessageSquare } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import { quoteLines } from "../comments/noteQuote";

/**
 * "Comment" over a selection in the doc (#1100; the mockup's selection
 * bubble button): it hands the selection, quoted, to the whole-page
 * composer. People who may only read can comment too, so it follows the
 * page's selection, not the editor's. No live anchor yet (#2535).
 */
export function SelectionComment({
  page,
  root,
  onComment,
  textOf,
}: {
  /** The positioned box the button sits in (the doc's page). */
  page: RefObject<HTMLElement | null>;
  /** The editor's own element: only selections inside it count. */
  root: () => HTMLElement | null;
  onComment: (quote: string) => void;
  /**
   * The selection's text from the doc itself, one block per line (the DOM's
   * text would carry the checklist boxes' hidden labels).
   */
  textOf: (s: Selection) => string | null;
}) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    const update = () => {
      const s = document.getSelection();
      const box = root();
      const host = page.current;
      if (
        !s ||
        s.isCollapsed ||
        !s.rangeCount ||
        !box ||
        !host ||
        !s.toString().trim() ||
        !box.contains(s.anchorNode) ||
        !box.contains(s.focusNode)
      ) {
        setAt(null);
        return;
      }
      const r = s.getRangeAt(0).getBoundingClientRect();
      const h = host.getBoundingClientRect();
      // Above the selection's top, centred on it; below it near the top.
      const top =
        r.top - h.top - 40 < 0 ? r.bottom - h.top + 8 : r.top - h.top - 40;
      const left = Math.max(
        0,
        Math.min(r.left - h.left + r.width / 2, h.width),
      );
      setAt({ top, left });
    };
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [page, root]);
  if (!at) return null;
  return (
    <div className="oa-doc-selcomment" style={{ top: at.top, left: at.left }}>
      <Button
        type="button"
        size="sm"
        variant="outline"
        // Keep the selection: the click reads it.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const s = document.getSelection();
          const quote = quoteLines(s ? (textOf(s) ?? s.toString()) : "");
          if (!quote) return;
          setAt(null);
          onComment(quote);
        }}
      >
        <MessageSquare aria-hidden="true" />
        Comment
      </Button>
    </div>
  );
}
