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
      className="flex w-[320px] flex-none flex-col overflow-y-auto border-0 border-l border-l-[var(--oa-border)] bg-card"
    >
      <CommentsBody textFormat={textFormat} />
    </aside>
  );
}

/** Full screen: an overlay at the right; phones: a bottom sheet. */
export function CommentsDialog({
  textFormat,
  onClose,
}: {
  textFormat: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    ref.current?.focus();
    return () => opener?.focus?.();
  }, [opener]);
  return (
    <section
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-label="Comments"
      className="fixed inset-x-0 bottom-0 z-30 flex max-h-[70vh] flex-col overflow-hidden rounded-t-xl border border-border bg-card shadow-lg outline-none min-[601px]:inset-x-auto min-[601px]:top-4 min-[601px]:right-4 min-[601px]:bottom-4 min-[601px]:max-h-none min-[601px]:w-[360px] min-[601px]:rounded-xl"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.stopPropagation();
          onClose();
        }
      }}
    >
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
  );
}
