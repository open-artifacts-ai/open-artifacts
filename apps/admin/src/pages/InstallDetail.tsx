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
import { installJobsQuery, installQuery, releasesQuery } from "../api/queries";
import { ActionDialog } from "../components/ActionDialog";
import { StateBadge, StatusBadge } from "../components/Bits";
import { fmtTime } from "../components/format";
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

const can = (i: Install, kind: JobKind) => canTransition(i.state, kind, "A");

function Actions({ install }: { install: Install }) {
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reason, setReason] = useState("");
  const [version, setVersion] = useState("");
  const releases = useQuery({
    ...releasesQuery(),
    enabled: dialog === "upgrade",
  });
  const id = install.id;
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
    done,
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
    done,
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
          ...(install.lease.until && install.lease.until > Date.now()
            ? { force: true }
            : {}),
        },
      }),
    done,
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
    { label: "Restore", show: can(install, "restore"), run: restore },
    { label: "Retry", show: can(install, "retry"), run: retry },
  ];
  const close = () => setDialog(null);
  const versions = (releases.data?.items ?? []).filter(
    (r) => r.installable && r.version !== install.version,
  );
  return (
    <section className="oa-actions" aria-label="Actions">
      {busy && (
        <p className="oa-note">
          A job is running on this install.{" "}
          <Link to="/jobs/$id" params={{ id: install.activeJobId ?? "" }}>
            View the job
          </Link>
        </p>
      )}
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
            {!!q.run.error && (
              <small role="alert" className="oa-inline-error">
                {errorCopy(q.run.error)}
              </small>
            )}
          </span>
        ))}
      {can(install, "suspend") && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => setDialog("suspend")}
        >
          Suspend
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
          title="Suspend"
          description="Visitors see the paused page until you resume."
          submitLabel="Suspend"
          canSubmit={reason.trim().length >= 1 && reason.trim().length <= 200}
          pending={suspend.isPending}
          error={suspend.error}
          onSubmit={() => suspend.mutate()}
        >
          <Label htmlFor="reason">Reason (1 to 200 characters)</Label>
          <Textarea
            id="reason"
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
          />
        </ActionDialog>
      )}
      {dialog === "delete" && (
        <ActionDialog
          open
          onClose={close}
          title="Delete install"
          description="The install closes now and can be restored until the grace period ends."
          expected={install.slug}
          submitLabel="Delete"
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
          title="Purge install"
          description="This removes the install for good. You may be asked to sign in again first."
          expected={install.slug}
          submitLabel="Purge"
          destructive
          pending={purge.isPending}
          error={purge.error}
          onSubmit={() => purge.mutate()}
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
        />
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
  return (
    <>
      <div className="oa-head">
        <h1>{i.slug}</h1>
        <StateBadge state={i.state} />
      </div>
      {i.mismatch && (
        <p className="oa-error" role="alert" data-testid="mismatch">
          State and serving disagree: {i.mismatch}
        </p>
      )}
      {i.state === "failed" && (
        <p className="oa-error" role="alert">
          The last job failed. Retry it or purge the install.
        </p>
      )}
      {i.state === "suspended" && (
        <p className="oa-note">
          Suspended {fmtTime(i.suspendedAt)}. Reason: {i.suspendReason}
        </p>
      )}
      {i.state === "deleting" && (
        <p className="oa-note">
          Deleted {fmtTime(i.deletedAt)}.{" "}
          {i.restorable
            ? `It can be restored until ${fmtTime(i.purgeAt)}.`
            : "It can no longer be restored."}
        </p>
      )}
      {i.lease.held && (
        <p className="oa-note" data-testid="lease">
          A job holds the lease until {fmtTime(i.lease.until)}.
        </p>
      )}
      <dl className="oa-fields">
        <dt>App</dt>
        <dd>{i.appHost}</dd>
        <dt>Content</dt>
        <dd>{i.contentHost}</dd>
        <dt>Serving</dt>
        <dd>{i.servingMode}</dd>
        <dt>Version</dt>
        <dd>
          {i.version ?? "none"}
          {i.previousVersion && ` (previous ${i.previousVersion})`}
        </dd>
        <dt>Tier</dt>
        <dd>{i.tier ?? "none"}</dd>
        <dt>Health</dt>
        <dd>{i.health}</dd>
        <dt>Owner</dt>
        <dd>{i.ownerEmail ?? "hidden"}</dd>
        <dt>Sign-in</dt>
        <dd>
          {i.auth.providers.join(", ")}
          {i.auth.domains.length > 0 && ` (${i.auth.domains.join(", ")})`}
        </dd>
        <dt>Source</dt>
        <dd>{i.source}</dd>
        <dt>Created</dt>
        <dd>{fmtTime(i.createdAt)}</dd>
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
