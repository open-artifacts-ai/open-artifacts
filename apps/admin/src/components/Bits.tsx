import type { InstallState, JobStatus } from "@oa/shared/provisioning";
import { Link } from "@tanstack/react-router";
import { ApiError } from "../api/client";
import { errorCopy } from "../api/errorCopy";
import { STATE_LABEL } from "./labels";

type Tone = "success" | "accent" | "warning" | "danger" | "muted";

const STATE_TONE = {
  provisioning: "accent",
  active: "success",
  suspended: "warning",
  deleting: "muted",
  deleted: "muted",
  failed: "danger",
} as const satisfies Record<InstallState, Tone>;
/** A colored dot and the state's label (the mock's .st). */
export const StateBadge = ({ state }: { state: InstallState }) => (
  <span className="oa-st" data-tone={STATE_TONE[state]} data-testid="state">
    {STATE_LABEL[state]}
  </span>
);

const STATUS_TONE = {
  queued: "muted",
  running: "accent",
  done: "success",
  failed: "danger",
} as const satisfies Record<JobStatus, Tone>;
export const StatusBadge = ({ status }: { status: JobStatus }) => (
  <span className="oa-st" data-tone={STATUS_TONE[status]} data-testid="status">
    {status}
  </span>
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
  // One page: nothing to page through, so no stray disabled links.
  if (!canPrev && !next) return null;
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
