// A query that failed: a danger notice with Retry, never an empty state.
import { Button } from "@oa/ui/shadcn";
import { errorCopy } from "../api/errorCopy";
import { Notice } from "./Notice";

export function LoadError({
  title,
  error,
  onRetry,
}: {
  /** "Couldn't load …". */
  title: string;
  error: unknown;
  onRetry: () => void;
}) {
  const detail = errorCopy(error, "");
  return (
    <Notice
      tone="danger"
      title={title}
      action={
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      }
    >
      {detail || undefined}
    </Notice>
  );
}
