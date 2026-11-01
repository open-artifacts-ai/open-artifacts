import { InstallIdSchema } from "@oa/shared/provisioning";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@oa/ui/shadcn";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { auditQuery } from "../api/queries";
import { Pager } from "../components/Bits";
import { fmtDayClock, shortId } from "../components/labels";
import { usePaging } from "../hooks/usePaging";
import { LoadError } from "../layout/LoadError";

const VERB: Record<string, string> = {
  "install.create": "created",
  "install.upgrade": "started an upgrade of",
  "install.rollback": "started a rollback of",
  "install.suspend": "paused",
  "install.resume": "resumed",
  "install.delete": "deleted",
  "install.restore": "restored",
  "install.purge": "deleted for good",
  "install.retry": "retried the create of",
  "install.release_lease": "released the lease on",
};
/** Design's sentence verb for a known action; the raw action name otherwise. */
export const actionPhrase = (action: string) =>
  Object.hasOwn(VERB, action) ? VERB[action] : action;

export function Audit({
  installId,
  actor,
  action,
}: {
  installId?: string;
  actor?: string;
  action?: string;
}) {
  const navigate = useNavigate();
  const paging = usePaging();
  const [draft, setDraft] = useState(installId ?? "");
  const [actorDraft, setActorDraft] = useState(actor ?? "");
  const valid = !installId || InstallIdSchema.safeParse(installId).success;
  const [bad, setBad] = useState(false);
  const q = useQuery({
    ...auditQuery({ cursor: paging.cursor, installId, actor, action }),
    enabled: valid,
  });
  return (
    <>
      <h1>Audit log</h1>
      <p className="oa-sub">
        Every admin action, agent token call and sign-in. Newest first.
      </p>
      <form
        className="oa-tools oa-audit-tools"
        onSubmit={(e) => {
          e.preventDefault();
          const id = draft.trim();
          const invalid = id !== "" && !InstallIdSchema.safeParse(id).success;
          setBad(invalid);
          if (invalid) return;
          paging.reset();
          void navigate({
            to: "/audit",
            search: {
              installId: id || undefined,
              actor: actorDraft.trim() || undefined,
              action: action || undefined,
            },
          });
        }}
      >
        <label>
          <span className="sr-only">Actor</span>
          <input
            maxLength={200}
            placeholder="Actor"
            value={actorDraft}
            onChange={(e) => setActorDraft(e.target.value)}
          />
        </label>
        <label className="oa-audit-action">
          <span className="sr-only">Action</span>
          <select
            value={action ?? ""}
            onChange={(e) => {
              paging.reset();
              void navigate({
                to: "/audit",
                search: {
                  installId,
                  actor,
                  action: e.target.value || undefined,
                },
              });
            }}
          >
            <option value="">Any action</option>
            {action && !Object.hasOwn(VERB, action) && (
              <option value={action}>{action}</option>
            )}
            {Object.keys(VERB).map((a) => (
              <option key={a} value={a}>
                {actionPhrase(a)}
              </option>
            ))}
          </select>
        </label>
        <label className="oa-search">
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.3 10.3l3 3" />
          </svg>
          <span className="sr-only">Install</span>
          <input
            placeholder="Install"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </label>
        <button type="submit" className="oa-btn">
          Filter
        </button>
        {(installId || actor || action) && (
          <Link
            className="oa-link"
            to="/audit"
            search={{
              installId: undefined,
              actor: undefined,
              action: undefined,
            }}
            onClick={() => {
              paging.reset();
              setDraft("");
              setActorDraft("");
              setBad(false);
            }}
          >
            Clear filter
          </Link>
        )}
      </form>
      {(bad || !valid) && (
        <p className="oa-error" role="alert">
          That is not an install id.
        </p>
      )}
      {q.isError ? (
        <LoadError
          title="Couldn't load the audit log"
          error={q.error}
          onRetry={() => void q.refetch()}
        />
      ) : q.data && q.data.items.length === 0 ? (
        <div className="oa-card oa-empty">
          <p>No audit entries.</p>
        </div>
      ) : q.data ? (
        <>
          <div className="oa-tablewrap oa-audit">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time (UTC)</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.data.items.map((e) => (
                  <TableRow key={e.id} data-outcome={e.outcome}>
                    <TableCell className="oa-mono">
                      {fmtDayClock(e.at)}
                    </TableCell>
                    <TableCell>
                      {e.actor.kind === "token"
                        ? `token: ${e.actor.label}`
                        : e.actor.label}
                    </TableCell>
                    <TableCell>
                      {actionPhrase(e.action)}
                      {e.outcome !== "ok" && (
                        <span className="oa-chip oa-chip-danger">
                          {e.outcome}
                          {e.code ? `: ${e.code}` : ""}
                        </span>
                      )}
                      {e.count > 1 && (
                        <span data-testid="count"> x{e.count}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {e.installId ? (
                        <Link to="/installs/$id" params={{ id: e.installId }}>
                          {e.installId}
                        </Link>
                      ) : (
                        ""
                      )}
                    </TableCell>
                    <TableCell className="oa-audit-detail">
                      {e.jobId && (
                        <>
                          <Link to="/jobs/$id" params={{ id: e.jobId }}>
                            job {shortId(e.jobId)}
                          </Link>{" "}
                        </>
                      )}
                      {e.detail && <code>{JSON.stringify(e.detail)}</code>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pager
            canPrev={paging.canPrev}
            next={q.data.nextCursor}
            onPrev={paging.prev}
            onNext={paging.next}
          />
        </>
      ) : null}
    </>
  );
}
