import { Button } from "@oa/ui/shadcn";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ApiError, api } from "../api/client";
import { codeCopy, errorCopy } from "../api/errorCopy";
import { installQuery, jobIsTerminal, jobQuery } from "../api/queries";
import { ActionDialog } from "../components/ActionDialog";
import { StatusBadge } from "../components/Bits";
import { fmtTime } from "../components/format";
import { useAction } from "../hooks/useAction";
import { LoadError } from "../layout/LoadError";

export function JobPage({ id }: { id: string }) {
  const q = useQuery(jobQuery(id));
  const job = q.data;
  const install = useQuery({
    ...installQuery(job?.installId ?? ""),
    enabled: !!job,
  });
  const [confirming, setConfirming] = useState(false);
  const cancel = useAction(
    (_: void, requestId) =>
      api.call("R25", {
        params: { jobId: id },
        body: { requestId, confirmSlug: install.data?.slug ?? "" },
      }),
    {
      invalidate: [["job", id], ["install"], ["world"]],
      onSuccess: () => setConfirming(false),
    },
  );
  if (q.isError)
    return q.error instanceof ApiError && q.error.status === 404 ? (
      <>
        <h1>Job not found</h1>
        <p>{errorCopy(q.error)}</p>
      </>
    ) : (
      <LoadError
        title="Couldn't load the job"
        error={q.error}
        onRetry={() => void q.refetch()}
      />
    );
  if (!job) return null;
  const live = !jobIsTerminal(job.status);
  return (
    <>
      <div className="oa-head">
        <h1>{job.kind} job</h1>
        <StatusBadge status={job.status} />
      </div>
      <p>
        Install:{" "}
        <Link to="/installs/$id" params={{ id: job.installId }}>
          {install.data?.slug ?? job.installId}
        </Link>
      </p>
      <ol className="oa-steps" aria-label="Steps">
        {job.steps.map((s, n) => {
          const state =
            job.status === "done" || n < job.stepIndex
              ? "done"
              : n === job.stepIndex
                ? job.status === "failed"
                  ? "failed"
                  : job.status === "running"
                    ? "current"
                    : "waiting"
                : "waiting";
          return (
            <li key={s} data-step={state}>
              {s.replaceAll("_", " ")} ({state})
            </li>
          );
        })}
      </ol>
      <dl className="oa-fields">
        <dt>Attempt</dt>
        <dd data-testid="attempt">{job.attempt}</dd>
        <dt>Started by</dt>
        <dd>{job.actor.label}</dd>
        <dt>Created</dt>
        <dd>{fmtTime(job.createdAt)}</dd>
        <dt>Finished</dt>
        <dd>{job.finishedAt ? fmtTime(job.finishedAt) : "not yet"}</dd>
        {job.retryAt && live && (
          <>
            <dt>Next retry</dt>
            <dd data-testid="retry-at">{fmtTime(job.retryAt)}</dd>
          </>
        )}
      </dl>
      {(job.error || job.lastErrorCode) && (
        <div className="oa-error" role="alert" data-testid="job-error">
          <strong>Last error</strong>
          <p>
            {codeCopy(job.lastErrorCode ?? job.error?.code) ??
              job.lastErrorCode}
          </p>
          {job.error && <p>{job.error.message}</p>}
        </div>
      )}
      {live && (
        <>
          <p className="oa-note">Updating every 2 seconds.</p>
          <Button
            variant="outline"
            disabled={!install.data}
            onClick={() => setConfirming(true)}
          >
            Cancel job
          </Button>
        </>
      )}
      {confirming && install.data && (
        <ActionDialog
          open
          onClose={() => {
            setConfirming(false);
            cancel.reset();
          }}
          title="Cancel job"
          description="The job stops and cleanup runs."
          expected={install.data.slug}
          submitLabel="Cancel job"
          destructive
          pending={cancel.isPending}
          error={cancel.error}
          onSubmit={() => cancel.mutate()}
        />
      )}
    </>
  );
}
