import {
  canTransition,
  type InstallDetail as Install,
  type JobKind,
} from "@oa/shared/provisioning";
import { Button, Label, Textarea } from "@oa/ui/shadcn";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ApiError, api } from "../api/client";
import { errorCopy } from "../api/errorCopy";
import {
  installJobsQuery,
  installQuery,
  jobQuery,
  releasesQuery,
} from "../api/queries";
import { reauthHref } from "../api/reauth";
import { ActionDialog } from "../components/ActionDialog";
import { ErrorLine, StateBadge, StatusBadge } from "../components/Bits";
import { fmtTime } from "../components/format";
import {
  fmtDay,
  HEALTH_LABEL,
  JOB_VERB,
  STATE_LABEL,
  stepCount,
  visibleSteps,
} from "../components/labels";
import { useAction } from "../hooks/useAction";
import { LoadError } from "../layout/LoadError";

type Dialog =
  | "upgrade"
  | "suspend"
  | "delete"
  | "purge"
  | "release-lease"
  | "cancel"
  | null;

const GRACE_DAYS = 7;
const REAUTH_MS = 10 * 60_000;
const can = (i: Install, kind: JobKind) => canTransition(i.state, kind, "A");

function Actions({ install }: { install: Install }) {
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reason, setReason] = useState("");
  const [version, setVersion] = useState("");
  const [force, setForce] = useState(false);
  const releases = useQuery({
    ...releasesQuery(),
    enabled: dialog === "upgrade",
  });
  const id = install.id;
  // Purge needs a Google sign-in from the last 10 minutes (authz: reauth_required).
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const fresh = !!me.data?.authAt && Date.now() - me.data.authAt < REAUTH_MS;
  const busy = install.activeJobId !== null;
  const done = {
    invalidate: [
      ["install", id],
      ["install-jobs", id],
      ["installs"],
      ["world"],
    ],
    onSuccess: (r: { job: { id: string } }) => {
      setDialog(null);
      void navigate({ to: "/jobs/$id", params: { id: r.job.id } });
    },
  };
  const upgrade = useAction(
    (_: void, requestId) =>
      api.call("R5", {
        params: { id },
        body: { requestId, ...(version ? { version } : {}) },
      }),
    { ...done, key: version },
  );
  const rollback = useAction(
    (_: void, requestId) =>
      api.call("R6", { params: { id }, body: { requestId } }),
    done,
  );
  const suspend = useAction(
    (_: void, requestId) =>
      api.call("R7", {
        params: { id },
        body: { requestId, reason: reason.trim() },
      }),
    { ...done, key: reason.trim() },
  );
  const resume = useAction(
    (_: void, requestId) =>
      api.call("R8", { params: { id }, body: { requestId } }),
    done,
  );
  const del = useAction(
    (_: void, requestId) =>
      api.call("R9", {
        params: { id },
        body: { requestId, confirmSlug: install.slug },
      }),
    done,
  );
  const restore = useAction(
    (_: void, requestId) =>
      api.call("R10", { params: { id }, body: { requestId } }),
    done,
  );
  const purge = useAction(
    (_: void, requestId) =>
      api.call("R11", {
        params: { id },
        body: { requestId, confirmSlug: install.slug },
      }),
    done,
  );
  const retry = useAction(
    (_: void, requestId) =>
      api.call("R12", { params: { id }, body: { requestId } }),
    done,
  );
  const lease = useAction(
    (_: void, requestId) =>
      api.call("R13", {
        params: { id },
        body: {
          requestId,
          confirmSlug: install.slug,
          ...(force ? { force: true } : {}),
        },
      }),
    { ...done, key: force },
  );
  const cancel = useAction(
    (_: void, requestId) =>
      api.call("R25", {
        params: { jobId: install.activeJobId ?? "" },
        body: { requestId, confirmSlug: install.slug },
      }),
    done,
  );
  const quick = [
    {
      label: "Roll back",
      show: can(install, "rollback") && install.previousVersion !== null,
      run: rollback,
    },
    { label: "Resume", show: can(install, "resume"), run: resume },
    {
      label: "Restore",
      show: can(install, "restore") && install.restorable,
      run: restore,
    },
    { label: "Retry", show: can(install, "retry"), run: retry },
  ];
  const live = !!install.lease.until && install.lease.until > Date.now();
  const close = () => {
    setDialog(null);
    setForce(false);
    for (const m of [upgrade, suspend, del, purge, lease, cancel]) m.reset();
  };
  const versions = (releases.data?.items ?? []).filter(
    (r) => r.installable && r.version !== install.version,
  );
  return (
    <section className="oa-actions" aria-label="Actions">
      {can(install, "upgrade") && (
        <Button disabled={busy} onClick={() => setDialog("upgrade")}>
          Upgrade
        </Button>
      )}
      {quick
        .filter((q) => q.show)
        .map((q) => (
          <span key={q.label}>
            <Button
              variant="outline"
              disabled={busy || q.run.isPending}
              onClick={() => q.run.mutate()}
            >
              {q.label}
            </Button>
            <ErrorLine error={q.run.error} />
          </span>
        ))}
      {can(install, "suspend") && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setDialog("suspend")}
        >
          Pause
        </Button>
      )}
      {can(install, "delete") && (
        <Button
          variant="destructive"
          disabled={busy}
          onClick={() => setDialog("delete")}
        >
          Delete
        </Button>
      )}
      {can(install, "purge") && (
        <Button
          variant="destructive"
          disabled={busy}
          onClick={() => setDialog("purge")}
        >
          Purge
        </Button>
      )}
      {install.lease.held && install.state !== "deleted" && (
        <Button variant="outline" onClick={() => setDialog("release-lease")}>
          Release lease
        </Button>
      )}
      {busy && (
        <Button variant="outline" onClick={() => setDialog("cancel")}>
          Cancel job
        </Button>
      )}

      {dialog === "upgrade" && (
        <ActionDialog
          open
          onClose={close}
          title="Upgrade"
          description={`Currently ${install.version ?? "none"}. Leave it on the default to take the latest release.`}
          submitLabel="Upgrade"
          pending={upgrade.isPending}
          error={upgrade.error}
          onSubmit={() => upgrade.mutate()}
        >
          <Label htmlFor="up-version">Version</Label>
          <select
            id="up-version"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
          >
            <option value="">Latest release</option>
            {versions.map((r) => (
              <option key={r.version} value={r.version}>
                {r.version}
              </option>
            ))}
          </select>
        </ActionDialog>
      )}
      {dialog === "suspend" && (
        <ActionDialog
          open
          onClose={close}
          title={`Pause ${install.slug}?`}
          description="Visitors see the paused page. Nothing is deleted, and you can resume it at any time."
          submitLabel={`Pause ${install.slug}`}
          canSubmit={reason.trim().length >= 1 && reason.trim().length <= 200}
          pending={suspend.isPending}
          error={suspend.error}
          onSubmit={() => suspend.mutate()}
        >
          <Label htmlFor="reason">Reason</Label>
          <Textarea
            id="reason"
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
          />
          <small className="oa-hint">
            Only admins and their agents see this.
          </small>
        </ActionDialog>
      )}
      {dialog === "delete" && (
        <ActionDialog
          open
          onClose={close}
          title={`Delete ${install.slug}?`}
          description={`${install.appHost} closes now and shows a closed page. You can restore it within ${GRACE_DAYS} days. After that it's deleted for good.`}
          expected={install.slug}
          submitLabel={`Delete ${install.slug}`}
          destructive
          pending={del.isPending}
          error={del.error}
          onSubmit={() => del.mutate()}
        />
      )}
      {dialog === "purge" && (
        <ActionDialog
          open
          onClose={close}
          title={`Delete ${install.slug} for good?`}
          description={`This can't be undone. Its artifacts, data and files are erased, and its people lose access.${fresh ? "" : " Sign in again to continue."}`}
          expected={fresh ? install.slug : undefined}
          submitLabel={fresh ? "Purge" : "Sign in again"}
          destructive={fresh}
          pending={purge.isPending}
          error={purge.error}
          onSubmit={() =>
            fresh
              ? purge.mutate()
              : api.redirect(
                  reauthHref(
                    `${window.location.pathname}${window.location.search}`,
                  ),
                )
          }
        />
      )}
      {dialog === "release-lease" && (
        <ActionDialog
          open
          onClose={close}
          title="Release lease"
          description="Only do this when no job is really running."
          expected={install.slug}
          submitLabel="Release lease"
          destructive
          pending={lease.isPending}
          error={lease.error}
          onSubmit={() => lease.mutate()}
        >
          {live && (
            <label className="oa-check">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
              />{" "}
              Force (the lease is held until {fmtTime(install.lease.until)})
            </label>
          )}
        </ActionDialog>
      )}
      {dialog === "cancel" && (
        <ActionDialog
          open
          onClose={close}
          title="Cancel job"
          description="The job stops and cleanup runs."
          expected={install.slug}
          submitLabel="Cancel job"
          destructive
          pending={cancel.isPending}
          error={cancel.error}
          onSubmit={() => cancel.mutate()}
        />
      )}
    </section>
  );
}

/** "Upgrading to 0.77.1, step 3 of 11, Reserve slug and hosts. Open job" */
function ActiveJob({ jobId }: { jobId: string }) {
  const q = useQuery(jobQuery(jobId));
  const job = q.data;
  const { n, of } = job ? stepCount(job) : { n: 0, of: 0 };
  const at = job
    ? visibleSteps(job.steps).find((s) => s.index === job.stepIndex)
    : undefined;
  return (
    <p className="oa-note" data-testid="active-job">
      {job ? (
        <>
          {JOB_VERB[job.kind].ing}
          {typeof job.args.to === "string" ? ` to ${job.args.to}` : ""}, step{" "}
          {n} of {of}
          {at ? `, ${at.label}` : ""}.{" "}
        </>
      ) : (
        "A job is running. "
      )}
      <Link to="/jobs/$id" params={{ id: jobId }}>
        Open job
      </Link>
    </p>
  );
}

export function InstallDetail({ id }: { id: string }) {
  const q = useQuery(installQuery(id));
  const jobs = useQuery(installJobsQuery(id));
  if (q.isError)
    return q.error instanceof ApiError && q.error.status === 404 ? (
      <>
        <h1>Install not found</h1>
        <p>{errorCopy(q.error)}</p>
        <Link to="/installs">Back to installs</Link>
      </>
    ) : (
      <LoadError
        title="Couldn't load the install"
        error={q.error}
        onRetry={() => void q.refetch()}
      />
    );
  const i = q.data;
  if (!i) return null;
  const last = jobs.data?.items[0];
  const rolledBack =
    last?.kind === "upgrade" && last.lastErrorCode === "upgrade_rolled_back";
  return (
    <>
      <p className="oa-crumbs">
        <Link to="/installs">Installs</Link> /
      </p>
      <div className="oa-head">
        <div style={{ flex: 1 }}>
          <h1>{i.slug}</h1>
          <p className="oa-sub">{i.appHost}</p>
        </div>
        <StateBadge state={i.state} />
      </div>
      {i.activeJobId && <ActiveJob jobId={i.activeJobId} />}
      {i.mismatch && (
        <p
          className="oa-banner oa-banner-warn"
          role="alert"
          data-testid="mismatch"
        >
          <strong>Routing doesn't match.</strong> {i.slug} ({i.mismatch}).
        </p>
      )}
      {rolledBack && last && (
        <p
          className="oa-banner oa-banner-warn"
          role="alert"
          data-testid="rolled-back"
        >
          <strong>
            Serving {i.version ?? "an older version"}
            {typeof last.args.to === "string" ? `, not ${last.args.to}` : ""}.
          </strong>{" "}
          The last upgrade rolled back.{" "}
          <Link to="/jobs/$id" params={{ id: last.id }}>
            The job says why.
          </Link>
        </p>
      )}
      {i.state === "failed" && (
        <p className="oa-error" role="alert">
          The last job failed. Retry it or purge the install.
        </p>
      )}
      {i.state === "suspended" && (
        <p className="oa-note">
          Paused {fmtDay(i.suspendedAt ?? i.createdAt)}. Reason:{" "}
          {i.suspendReason}
        </p>
      )}
      {i.state === "deleting" && (
        <p className="oa-note">
          Deleted {fmtDay(i.deletedAt ?? i.createdAt)}.{" "}
          {i.restorable
            ? `You can restore it until ${fmtDay(i.purgeAt ?? 0)}.`
            : "It can no longer be restored."}
        </p>
      )}
      {i.lease.held && (
        <p className="oa-note" data-testid="lease">
          A job holds the lease until {fmtTime(i.lease.until)}.
        </p>
      )}
      <dl className="oa-fields">
        <dt>State</dt>
        <dd>{STATE_LABEL[i.state]}</dd>
        <dt>Health</dt>
        <dd>{HEALTH_LABEL[i.health]}</dd>
        <dt>Serving</dt>
        <dd>
          {i.version ?? "nothing"}
          {i.previousVersion && ` (previous ${i.previousVersion})`}
        </dd>
        <dt>Routing</dt>
        <dd>{i.servingMode}</dd>
        <dt>Tier · Sign-in</dt>
        <dd>
          {i.tier ? i.tier[0].toUpperCase() + i.tier.slice(1) : "None"} ·{" "}
          {i.auth.providers
            .map((p) => (p === "google" ? "Google" : "Email"))
            .join(", ")}
          {i.auth.domains.length > 0 &&
            ` · ${i.auth.domains.length} ${i.auth.domains.length === 1 ? "domain" : "domains"}`}
        </dd>
        <dt>Owner</dt>
        <dd>{i.ownerEmail ?? "hidden"}</dd>
        <dt>Created</dt>
        <dd>{fmtDay(i.createdAt)}</dd>
        <dt>Domains</dt>
        <dd>{i.auth.domains.join(", ") || "none"}</dd>
        <dt>Install id</dt>
        <dd>{i.id}</dd>
      </dl>
      <Actions install={i} />
      <h2>Recent jobs</h2>
      {jobs.data && jobs.data.items.length === 0 && (
        <p className="oa-placeholder">No jobs yet.</p>
      )}
      <ul className="oa-jobs">
        {jobs.data?.items.map((j) => (
          <li key={j.id}>
            <Link to="/jobs/$id" params={{ id: j.id }}>
              {j.kind}
            </Link>{" "}
            <StatusBadge status={j.status} /> {fmtTime(j.createdAt)}
          </li>
        ))}
      </ul>
    </>
  );
}
