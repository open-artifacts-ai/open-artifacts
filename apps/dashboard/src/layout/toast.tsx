// Every dashboard toast, on Sonner (@oa/ui/shadcn). The Toaster's defaults
// are Design's (position, 5s, at most 3, close button, tone in the icon);
// here: 8s for errors and toasts with an action, and errors announced
// assertively (the title is an alert inside Sonner's polite region).
import { Toaster as Sonner, toast as sonner } from "@oa/ui/shadcn";
import type { ReactNode } from "react";

export type ToastOptions = {
  /** Text, or inline content such as a link. */
  title: ReactNode;
  description?: ReactNode;
  /** "neutral": no icon. */
  tone?: "info" | "success" | "danger" | "warning" | "neutral";
  /** A button in the toast, e.g. Undo. Clicking it also dismisses. */
  action?: { label: string; onClick(): void };
  /** A toast with the same id replaces the one showing. */
  id?: string;
  /** Milliseconds (default: Design's, see above). */
  duration?: number;
  /** The toast closed: dismissed, timed out or replaced by its action. */
  onClose?: () => void;
};

const LONG = 8000;

export function toast({
  title,
  description,
  tone,
  action,
  id,
  duration,
  onClose,
}: ToastOptions) {
  const danger = tone === "danger";
  const opts = {
    id,
    description,
    duration: duration ?? (danger || action ? LONG : undefined),
    action: action && { label: action.label, onClick: () => action.onClick() },
    onDismiss: onClose,
    onAutoClose: onClose,
  };
  if (danger) return sonner.error(<span role="alert">{title}</span>, opts);
  if (tone === "success") return sonner.success(title, opts);
  if (tone === "warning") return sonner.warning(title, opts);
  if (tone === "neutral") return sonner(title, opts);
  return sonner.info(title, opts);
}

/** The app's one Toaster. The close button is named "Dismiss", with a 24px
    hit area and the 2px focus ring. */
export function Toaster() {
  return (
    <Sonner
      toastOptions={{
        closeButtonAriaLabel: "Dismiss",
        classNames: {
          // Popover surface, foreground ×, and a strong edge (3:1 or more in
          // both themes) so the button reads on any toast.
          closeButton:
            "size-6! bg-popover! text-foreground! border-[var(--oa-border-strong)]! focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
        },
      }}
    />
  );
}
