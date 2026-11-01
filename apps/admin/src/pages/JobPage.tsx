import type { Job } from "@oa/shared/provisioning";
import { Button } from "@oa/ui/shadcn";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { ApiError, api } from "../api/client";
import { codeCopy, errorCopy } from "../api/errorCopy";
import { installQuery, jobIsTerminal, jobQuery } from "../api/queries";
import { ActionDialog } from "../components/ActionDialog";
import { ErrorLine } from "../components/Bits";
import {
  fmtClock,
  fmtIn,
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

/**
 * Under the step the job is on: "Attempt 2 · cf_error · retrying in 1 min".
 * The attempt shows only from the second one; a failed step shows its code.
 */
function AttemptLine({ job, now }: { job: Job; now: number }) {
  const code = job.lastErrorCode ?? job.error?.code ?? null;
  const retry = job.retryAt && job.status !== "failed" ? job.retryAt : null;
  const parts: ReactNode[] = [];
  if (job.attempt > 1)
    parts.push(
      <span key="a" data-testid="attempt">
        Attempt {job.attempt}
      </span>,
    );
  if (code) parts.push(code);
  if (retry)
    parts.push(
      <span key="r" data-testid="retry-at">
        {retry > now ? `retrying in ${fmtIn(retry - now)}` : "retrying now"}
      </span>,
    );
  if (!parts.length) return null;
  return (
    <small data-testid="attempt-line">
      {parts.map((p, i) => (
        <Fragment key={typeof p === "string" ? p : i}>
          {i > 0 && " · "}
          {p}
        </Fragment>
      ))}
    </small>
  );
}

/** Ticks while a retry is pending, so "retrying in 1 min" stays true between polls. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, [active]);
  return now;
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
  const now = useNow(!!job?.retryAt && !jobIsTerminal(job.status));
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
  return (
    <>
      <p className="oa-crumbs">
        <Link to="/installs">Installs</Link> /{" "}
        <Link to="/installs/$id" params={{ id: job.installId }}>
          {slug ?? job.installId}
        </Link>
      </p>
      <div className="oa-head oa-head-loose">
        <div style={{ flex: 1 }}>
          <h1>
            {verb.ing} {slug ?? ""}
          </h1>
          <p className="oa-sub">
            Job {shortId(job.id)} · started {fmtClock(job.createdAt)} by{" "}
            {job.actor.label} · step {n} of {of}
            <span className="sr-only" data-testid="status">
              {" "}
              · {job.status}
            </span>
          </p>
        </div>
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
          <div className="oa-card oa-steps-card">
            <ol className="oa-steps" aria-label="Steps">
              {shown.map((s) => {
                const st = stepState(job, s.index);
                return (
                  <li key={s.id} data-step={st}>
                    {s.label}
                    {(st === "current" ||
                      st === "failed" ||
                      (live && s.index === job.stepIndex)) &&
                      (job.lastErrorCode || job.error) && (
                        <AttemptLine job={job} now={now} />
                      )}
                  </li>
                );
              })}
            </ol>
          </div>
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
        <aside className="oa-side oa-job-side">
          {live && (
            <>
              <h2>If you cancel</h2>
              <p>
                The job stops now and a cleanup job undoes what it did. Type the
                slug to confirm.
              </p>
            </>
          )}
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
