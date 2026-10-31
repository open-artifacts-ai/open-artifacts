import type { Job } from "@oa/shared/provisioning";
import { Button } from "@oa/ui/shadcn";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ApiError, api } from "../api/client";
import { codeCopy, errorCopy } from "../api/errorCopy";
import { installQuery, jobIsTerminal, jobQuery } from "../api/queries";
import { ActionDialog } from "../components/ActionDialog";
import { ErrorLine, StatusBadge } from "../components/Bits";
import {
  fmtClock,
  JOB_VERB,
  shortId,
  stepCount,
  visibleSteps,
} from "../components/labels";
import { useAction } from "../hooks/useAction";
import { LoadError } from "../layout/LoadError";

/** The first shown step the job has not passed, or the one it stopped at. */
const stepState = (job: Job, index: number) =>
  job.status === "done" || index < job.stepIndex
    ? "done"
    : index > job.stepIndex
      ? "waiting"
      : job.status === "failed"
        ? "failed"
        : job.status === "running"
          ? "current"
          : "waiting";

/** "Attempt 2 · cf_error · next try at 11:42" */
function attemptLine(job: Job, now: number) {
  const parts = [`Attempt ${job.attempt}`];
  if (job.lastErrorCode) parts.push(job.lastErrorCode);
  if (job.retryAt && job.status !== "failed")
    parts.push(`next try at ${fmtClock(job.retryAt)}`);
  return parts.join(" · ");
}

export function JobPage({ id }: { id: string }) {
  const navigate = useNavigate();
  const q = useQuery(jobQuery(id));
  const job = q.data;
  const install = useQuery({
    ...installQuery(job?.installId ?? ""),
    enabled: !!job,
  });
  const slug = install.data?.slug;
  const [confirming, setConfirming] = useState(false);
  const cancel = useAction(
    (_: void, requestId) =>
      api.call("R25", {
        params: { jobId: id },
        body: { requestId, confirmSlug: slug ?? "" },
      }),
    {
      invalidate: [["job", id], ["install"], ["world"]],
      onSuccess: () => setConfirming(false),
    },
  );
  const retry = useAction(
    (_: void, requestId) =>
      api.call("R12", {
        params: { id: job?.installId ?? "" },
        body: { requestId },
      }),
    {
      invalidate: [["job", id], ["install"], ["installs"], ["world"]],
      onSuccess: (r) =>
        void navigate({ to: "/jobs/$id", params: { id: r.job.id } }),
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
  const shown = visibleSteps(job.steps);
  const { n, of } = stepCount(job);
  const stoppedAt = shown.find((s) => s.index === job.stepIndex);
  const routeAt = job.steps.indexOf("route");
  const code = job.lastErrorCode ?? job.error?.code ?? null;
  const verb = JOB_VERB[job.kind];
  const now = Date.now();
  return (
    <>
      <p className="oa-crumbs">
        <Link to="/installs">Installs</Link> /{" "}
        <Link to="/installs/$id" params={{ id: job.installId }}>
          {slug ?? job.installId}
        </Link>{" "}
        /
      </p>
      <div className="oa-head">
        <div style={{ flex: 1 }}>
          <h1>
            {verb.ing} {slug ?? ""}
          </h1>
          <p className="oa-sub">
            Job {shortId(job.id)} · started {fmtClock(job.createdAt)} by{" "}
            {job.actor.label} · step {n} of {of}
          </p>
        </div>
        <StatusBadge status={job.status} />
        {live && (
          <Button
            variant="outline"
            disabled={!install.data}
            onClick={() => setConfirming(true)}
          >
            Cancel job
          </Button>
        )}
      </div>
      <div className="oa-split">
        <div>
          <ol className="oa-steps" aria-label="Steps">
            {shown.map((s) => {
              const st = stepState(job, s.index);
              return (
                <li key={s.id} data-step={st}>
                  {s.label}
                  {(st === "current" || (live && s.index === job.stepIndex)) &&
                    job.lastErrorCode && (
                      <small data-testid="attempt-line">
                        {attemptLine(job, now)}
                      </small>
                    )}
                </li>
              );
            })}
          </ol>
          <dl className="oa-fields">
            <dt>Attempt</dt>
            <dd data-testid="attempt">{job.attempt}</dd>
            {job.retryAt && live && (
              <>
                <dt>Next retry</dt>
                <dd data-testid="retry-at">at {fmtClock(job.retryAt)}</dd>
              </>
            )}
          </dl>
          {job.status === "failed" && (
            <div className="oa-error" role="alert" data-testid="job-error">
              <p>
                <strong>
                  {verb.noun} stopped
                  {stoppedAt ? ` at "${stoppedAt.label}"` : ""}
                  {code ? `: ${code}` : ""}.
                </strong>
                {job.kind === "create" &&
                routeAt >= 0 &&
                job.stepIndex < routeAt
                  ? " Nothing was routed."
                  : ""}
              </p>
              {codeCopy(code) && <p>{codeCopy(code)}</p>}
              {job.error && <p>{job.error.message}</p>}
              {job.kind === "create" && install.data?.state === "failed" && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={retry.isPending}
                    onClick={() => retry.mutate()}
                  >
                    Retry
                  </Button>
                  <ErrorLine error={retry.error} />
                </>
              )}
            </div>
          )}
          {live && job.lastErrorCode && (
            <div className="oa-error" data-testid="job-error">
              <strong>Last error</strong>
              <p>{codeCopy(job.lastErrorCode) ?? job.lastErrorCode}</p>
              {job.error && <p>{job.error.message}</p>}
            </div>
          )}
        </div>
        <aside className="oa-side">
          <h2>If you cancel</h2>
          <p>
            The job stops now and a cleanup job undoes what it did. Type the
            slug to confirm.
          </p>
          <h2>If it fails</h2>
          <p>Nothing is routed. Retry from the install.</p>
          {live && <p className="oa-note">Updating every 2 seconds.</p>}
        </aside>
      </div>
      {confirming && install.data && (
        <ActionDialog
          open
          onClose={() => {
            setConfirming(false);
            cancel.reset();
          }}
          title="Cancel job"
          description="The job stops now and a cleanup job undoes what it did."
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
