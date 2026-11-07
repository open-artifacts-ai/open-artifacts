import { Button } from "@oa/ui/shadcn";
import { X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { TXT } from "../ui";
import { CommentsBody } from "./CommentsBody";

/** Where the comments list lives (Design's 1C + 3D). */
export type Surface = "column" | "panel" | "dialog";

export const WIDE_QUERY = "(min-width: 960px)";
export const PHONE_QUERY = "(max-width: 600px)";

const media = (q: string) => ({
  subscribe: (cb: () => void) => {
    const m = window.matchMedia?.(q);
    m?.addEventListener?.("change", cb);
    return () => m?.removeEventListener?.("change", cb);
  },
  get: () => window.matchMedia?.(q).matches ?? false,
});
const wide = media(WIDE_QUERY);
const phone = media(PHONE_QUERY);

/**
 * A margin column beside the page from 960px; below that, a tab of the side
 * panel; on phones and in full screen, a sheet or overlay.
 */
export function useSurface(chromeless: boolean): Surface {
  const isWide = useSyncExternalStore(wide.subscribe, wide.get, () => true);
  const isPhone = useSyncExternalStore(phone.subscribe, phone.get, () => false);
  if (chromeless || isPhone) return "dialog";
  return isWide ? "column" : "panel";
}

/** The margin column: cards in document order beside the frame. */
export function CommentsColumn({ textFormat }: { textFormat: boolean }) {
  return (
    <aside
      aria-label="Comments"
      className="flex w-[340px] flex-none flex-col overflow-y-auto border-0 border-l border-l-[var(--oa-border)] bg-card"
    >
      <CommentsBody textFormat={textFormat} />
    </aside>
  );
}

/** Full screen: an overlay at the right; phones: a bottom sheet. */
export function CommentsDialog({
  textFormat,
  onClose,
  pinCard = null,
}: {
  textFormat: boolean;
  onClose: () => void;
  /** The pin whose card is being read: keep the sheet short so its pin stays in view (#1657). */
  pinCard?: string | null;
}) {
  const ref = useRef<HTMLElement>(null);
  const [full, setFull] = useState(false);
  // #1657: reading a pin card shrinks the sheet, so the image and that pin
  // stay visible; dragging it back up still works. Keyed on the pin, so
  // moving from one pin's card to another's shrinks it again.
  useEffect(() => {
    if (pinCard) setFull(false);
  }, [pinCard]);
  const height = full ? "full" : pinCard ? "pin" : "half";
  const drag = useRef<number | null>(null);
  const dragged = useRef(false);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    ref.current?.focus();
    return () => opener?.focus?.();
  }, [opener]);
  return (
    <>
      <div
        data-sheet-backdrop=""
        aria-hidden="true"
        className="fixed inset-0 z-20 bg-black/40 min-[601px]:hidden"
        onClick={onClose}
      />
      <section
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-label="Comments"
        data-sheet-height={height}
        className={`group/sheet fixed inset-x-0 bottom-0 z-30 flex flex-col overflow-hidden rounded-t-xl border border-border bg-card shadow-lg outline-none transition-[height] motion-reduce:transition-none max-[600px]:data-[sheet-height=half]:h-[50dvh] max-[600px]:data-[sheet-height=full]:h-[90dvh] max-[600px]:data-[sheet-height=pin]:h-[34dvh] min-[601px]:inset-x-auto min-[601px]:top-14 min-[601px]:right-4 min-[601px]:bottom-4 min-[601px]:w-[360px] min-[601px]:rounded-xl`}
        onFocusCapture={(e) => {
          // The phone keyboard would cover a half-height sheet.
          const t = e.target as HTMLElement;
          if (t.tagName === "TEXTAREA" || t.tagName === "INPUT") setFull(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !e.defaultPrevented) {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <button
          type="button"
          data-sheet-handle=""
          aria-label={full ? "Shrink comments" : "Expand comments"}
          className="flex w-full flex-none cursor-grab touch-none items-center justify-center border-0 bg-transparent py-2 min-[601px]:hidden"
          onClick={() => {
            if (dragged.current) dragged.current = false;
            else setFull((f) => !f);
          }}
          onPointerDown={(e) => {
            drag.current = e.clientY;
            dragged.current = false;
            e.currentTarget.setPointerCapture?.(e.pointerId);
          }}
          onPointerCancel={() => {
            drag.current = null;
            dragged.current = false;
          }}
          onPointerUp={(e) => {
            const from = drag.current;
            drag.current = null;
            if (from == null) return;
            const dy = e.clientY - from;
            dragged.current = Math.abs(dy) > 30;
            if (dy < -30) setFull(true);
            else if (dy > 30) setFull(false);
          }}
        >
          <span className="h-1 w-10 rounded-full bg-border" />
        </button>
        <div className={`flex items-center justify-between px-4 pt-3 ${TXT}`}>
          <h2 className="m-0 font-medium">Comments</h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close comments"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <CommentsBody textFormat={textFormat} />
        </div>
      </section>
    </>
  );
}
