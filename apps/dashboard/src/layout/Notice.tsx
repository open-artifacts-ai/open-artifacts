// A tone-coloured notice on shadcn's Alert: the old Banner's props (tone,
// title, text, an action, a decorative icon, a one-line size, a dismiss),
// spelled once in Design's mapping (title -> AlertTitle, text ->
// AlertDescription, action and dismiss -> AlertAction).
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
  Button,
} from "@oa/ui/shadcn";
import { XIcon } from "lucide-react";
import type { ReactNode } from "react";

export function Notice({
  tone,
  title,
  children,
  action,
  icon,
  compact = false,
  onDismiss,
}: {
  tone: "info" | "success" | "warning" | "danger";
  /** Omit for a single-line notice. */
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  /** An aria-hidden svg: the first child, so Alert lays it out. */
  icon?: ReactNode;
  /** Tighter padding for a one-line strip. */
  compact?: boolean;
  onDismiss?: () => void;
}) {
  return (
    <Alert variant={tone} size={compact ? "sm" : "default"}>
      {icon}
      {title && <AlertTitle>{title}</AlertTitle>}
      {children && (
        <AlertDescription className="w-full justify-self-stretch *:justify-self-stretch">
          {children}
        </AlertDescription>
      )}
      {(action || onDismiss) && (
        <AlertAction>
          {action}
          {onDismiss && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Dismiss"
              onClick={onDismiss}
            >
              <XIcon aria-hidden="true" />
            </Button>
          )}
        </AlertAction>
      )}
    </Alert>
  );
}
