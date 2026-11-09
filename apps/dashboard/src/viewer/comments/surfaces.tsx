import { Button } from "@oa/ui/shadcn";
import { MessageSquare, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { TXT } from "../ui";
import { CommentsBody } from "./CommentsBody";
import { useCommentsApi } from "./useComments";

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
const coarse = media("(pointer: coarse)");
const narrow = media("(max-width: 599.98px)");

/** Touch input (#1732). */
export const useCoarsePointer = () =>
  useSyncExternalStore(coarse.subscribe, coarse.get, () => false);
/** Below 600px: the header button's short label. */
export const useNarrow = () =>
  useSyncExternalStore(narrow.subscribe, narrow.get, () => false);

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

/**
 * #1732: on touch, a full-width bar at the bottom of the viewer while text is
 * selected in the frame. Drawn by the shell (the frame's own button is off on
 * touch). The polite region announces once, when the bar appears.
 */
const ANNOUNCE_MS = 10_000;

export function SelectionBar() {
  const api = useCommentsApi();
  const touch = useCoarsePointer();
  const show = touch && api.hasSelection;
  // Announce when the bar appears, at most once per ANNOUNCE_MS: page code
  // can flip the selection state as often as it likes.
  const [say, setSay] = useState(false);
  const lastSaid = useRef(0);
  useEffect(() => {
    if (!show) {
      setSay(false);
      return;
    }
    if (Date.now() - lastSaid.current < ANNOUNCE_MS) return;
    lastSaid.current = Date.now();
    setSay(true);
  }, [show]);
  return (
    <>
      <div role="status" className="sr-only">
        {say ? "Comment on selection available" : ""}
      </div>
      {show && (
        // The bar is the chrome surface; the 48px accent button sits above the
        // home indicator (Design's final: plain bar, no quote line).
        <div className="fixed inset-x-0 bottom-0 z-20 animate-in border-t border-t-border bg-card px-3 pt-2 pb-[calc(0.5rem_+_env(safe-area-inset-bottom))] duration-200 slide-in-from-bottom motion-reduce:animate-none!">
          <button
            type="button"
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border-0 bg-[var(--oa-accent)] font-semibold text-[var(--oa-accent-text)] text-[15px] hover:bg-[var(--oa-accent-fg)]"
            // No preventDefault on press: WebKit then drops the tap's click.
            // The frame keeps the last selection if this tap collapses it.
            onClick={api.commentOnSelection}
          >
            <MessageSquare className="size-[18px]" aria-hidden="true" />
            Comment on selection
          </button>
        </div>
      )}
    </>
  );
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
  const api = useCommentsApi();
  const [full, setFull] = useState(false);
  // #1657: reading a pin card shrinks the sheet, so the image and that pin
  // stay visible; dragging it back up still works. Keyed on the pin, so
  // moving from one pin's card to another's shrinks it again.
  useEffect(() => {
    if (pinCard) setFull(false);
  }, [pinCard]);
  // #1865: writing a comment on a selection keeps the sheet short, with only
  // its composer, so the highlighted quote stays in sight above it. Dragging
  // up still works, and closing the draft returns the sheet to the height it
  // had before.
  const drafting = api.draft !== null && "anchor" in api.draft;
  const wasDrafting = useRef(false);
  const fullBefore = useRef(false);
  useEffect(() => {
    if (drafting && !wasDrafting.current) {
      wasDrafting.current = true;
      fullBefore.current = full;
      setFull(false);
    } else if (!drafting && wasDrafting.current) {
      wasDrafting.current = false;
      setFull(fullBefore.current);
    }
  }, [drafting, full]);
  const height = full ? "full" : pinCard || drafting ? "pin" : "half";
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
          // #1865: a selection draft rests short on purpose, so the quote above
          // it stays visible while the keyboard is up; the frame scrolls the
          // quote clear of the sheet instead of growing the sheet.
          if (drafting) return;
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
        {/* #1865: the short draft sheet is the composer alone. */}
        <div
          className={`flex items-center justify-between px-4 pt-3 ${TXT} ${drafting ? "hidden" : ""}`}
        >
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
          <CommentsBody textFormat={textFormat} composerOnly={drafting} />
        </div>
      </section>
    </>
  );
}
