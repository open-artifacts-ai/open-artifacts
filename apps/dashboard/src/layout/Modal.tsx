// A controlled shadcn dialog: title, description, body and footer, with
// focus returned to whatever opened it (there is no Radix Trigger).
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@oa/ui/shadcn";
import { type ReactNode, useRef } from "react";

const SHEET =
  "max-[640px]:top-auto max-[640px]:bottom-0 max-[640px]:max-w-full max-[640px]:translate-y-0 max-[640px]:rounded-b-none";

/** Header, body and footer of a dialog. */
export function Modal({
  open = true,
  onClose,
  title,
  description,
  footer,
  children,
  sheetOnPhone = false,
  wide = false,
  stickyFooter = false,
}: {
  open?: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  footer: ReactNode;
  children?: ReactNode;
  /** Below 640px: a full-width sheet from the bottom. */
  sheetOnPhone?: boolean;
  /** From 640px up: 720px wide instead of 440px (full width below). */
  wide?: boolean;
  /** The body scrolls and the footer stays in view at the bottom. */
  stickyFooter?: boolean;
}) {
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        // Radix warns about a missing description unless this is explicit.
        {...(description ? {} : { "aria-describedby": undefined })}
        // The card is centered at a fixed spot, so a body taller than a phone
        // screen (the token-created dialog, #1383) would put its footer past
        // the viewport with nothing to scroll: cap it and let it scroll.
        className={`max-h-[calc(100dvh-2rem)] gap-[var(--oa-space-4)] ${
          stickyFooter ? "flex flex-col overflow-hidden" : "overflow-y-auto"
        } ${wide ? "sm:max-w-[720px]" : "sm:max-w-[440px]"} ${sheetOnPhone ? SHEET : ""}`}
        // No Radix Trigger (the dialog is controlled), so put focus back on
        // whatever opened it, as a trigger would.
        onOpenAutoFocus={() => {
          opener.current = document.activeElement as HTMLElement | null;
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          opener.current?.focus();
        }}
      >
        <DialogHeader className={stickyFooter ? "shrink-0" : undefined}>
          <DialogTitle className="text-[length:var(--oa-text-lg)]">
            {title}
          </DialogTitle>
          {description && (
            <DialogDescription className="text-[length:var(--oa-text-sm)]">
              {description}
            </DialogDescription>
          )}
        </DialogHeader>
        {stickyFooter ? (
          <div
            data-slot="modal-body"
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {children}
          </div>
        ) : (
          children
        )}
        <DialogFooter className={stickyFooter ? "shrink-0" : undefined}>
          {footer}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
