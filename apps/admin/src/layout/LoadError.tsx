import { Button } from "@oa/ui/shadcn";
import { ApiError } from "../api/client";

/** "Couldn't load ..." with a Retry button. Pattern copied from apps/dashboard. */
export function LoadError({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: unknown;
  onRetry: () => void;
}) {
  const detail =
    error instanceof ApiError
      ? `The server answered ${error.status}.`
      : "Check your connection.";
  return (
    <div className="oa-error" role="alert">
      <strong>{title}</strong>
      <p>{detail}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
