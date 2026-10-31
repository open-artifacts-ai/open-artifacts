import type { InstallState, JobStatus } from "@oa/shared/provisioning";
import { Badge } from "@oa/ui/shadcn";
import { Link } from "@tanstack/react-router";
import { ApiError } from "../api/client";
import { errorCopy } from "../api/errorCopy";

const STATE_VARIANT = {
  provisioning: "secondary",
  active: "default",
  suspended: "outline",
  deleting: "destructive",
  deleted: "ghost",
  failed: "destructive",
} as const satisfies Record<InstallState, string>;
export const StateBadge = ({ state }: { state: InstallState }) => (
  <Badge variant={STATE_VARIANT[state]} data-testid="state">
    {state}
  </Badge>
);

const STATUS_VARIANT = {
  queued: "secondary",
  running: "default",
  done: "outline",
  failed: "destructive",
} as const satisfies Record<JobStatus, string>;
export const StatusBadge = ({ status }: { status: JobStatus }) => (
  <Badge variant={STATUS_VARIANT[status]} data-testid="status">
    {status}
  </Badge>
);

/** A failed call in plain words; job_in_progress links the running job. */
export function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  const jobId =
    error instanceof ApiError &&
    error.code === "job_in_progress" &&
    error.details &&
    typeof error.details === "object" &&
    "jobId" in error.details &&
    typeof error.details.jobId === "string"
      ? error.details.jobId
      : null;
  return (
    <p className="oa-error" role="alert">
      {errorCopy(error)}
      {jobId && (
        <>
          {" "}
          <Link to="/jobs/$id" params={{ id: jobId }}>
            View the running job
          </Link>
        </>
      )}
    </p>
  );
}

/** Prev and next over cursor pages. */
export function Pager({
  canPrev,
  next,
  onPrev,
  onNext,
}: {
  canPrev: boolean;
  next: string | null | undefined;
  onPrev: () => void;
  onNext: (cursor: string) => void;
}) {
  return (
    <div className="oa-pager">
      <button
        type="button"
        className="oa-link"
        disabled={!canPrev}
        onClick={onPrev}
      >
        Previous
      </button>
      <button
        type="button"
        className="oa-link"
        disabled={!next}
        onClick={() => next && onNext(next)}
      >
        Next
      </button>
    </div>
  );
}
