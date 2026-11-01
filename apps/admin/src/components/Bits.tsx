import type { InstallState, JobStatus } from "@oa/shared/provisioning";
import { Button } from "@oa/ui/shadcn";
import { Link } from "@tanstack/react-router";
import { ApiError } from "../api/client";
import { errorCopy } from "../api/errorCopy";
import { JOB_STATUS_LABEL, STATE_LABEL } from "./labels";

type Tone = "success" | "accent" | "warning" | "danger" | "muted";

const STATE_TONE = {
  provisioning: "accent",
  active: "success",
  suspended: "warning",
  deleting: "muted",
  deleted: "muted",
  failed: "danger",
} as const satisfies Record<InstallState, Tone>;
/** A colored dot and the state's label (the mock's .st); `chip` sets it on a pill. */
export const StateBadge = ({
  state,
  chip,
}: {
  state: InstallState;
  chip?: boolean;
}) => (
  <span
    className={chip ? "oa-st oa-st-chip" : "oa-st"}
    data-tone={STATE_TONE[state]}
    data-testid="state"
  >
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
    {JOB_STATUS_LABEL[status]}
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

/** Prev and next over cursor pages: small outline buttons, hidden on one page. */
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
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!canPrev}
        onClick={onPrev}
      >
        Previous
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!next}
        onClick={() => next && onNext(next)}
      >
        Next
      </Button>
    </div>
  );
}
