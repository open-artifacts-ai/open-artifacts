// A query that failed: a danger notice with Retry, never an empty state.
import { Button } from "@oa/ui/shadcn";
import { errorCopy } from "../api/errorCopy";
import { Notice } from "./Notice";

export function LoadError({
  title,
  error,
  onRetry,
  busy = false,
}: {
  /** "Couldn't load …". */
  title: string;
  error: unknown;
  onRetry: () => void;
  /** A retry is running. aria-disabled, not disabled: focus stays on the button. */
  busy?: boolean;
}) {
  const detail = errorCopy(error, "");
  return (
    <Notice
      tone="danger"
      title={title}
      action={
        <Button
          variant="outline"
          size="sm"
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          className={busy ? "cursor-not-allowed opacity-50" : undefined}
          onClick={busy ? undefined : onRetry}
        >
          Retry
        </Button>
      }
    >
      {detail || undefined}
    </Notice>
  );
}
