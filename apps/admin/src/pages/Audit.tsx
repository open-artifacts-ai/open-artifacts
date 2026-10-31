import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { auditQuery } from "../api/queries";
import { Pager } from "../components/Bits";
import { fmtTime } from "../components/format";
import { usePaging } from "../hooks/usePaging";
import { LoadError } from "../layout/LoadError";

export function Audit({ installId }: { installId?: string }) {
  const navigate = useNavigate();
  const paging = usePaging();
  const [draft, setDraft] = useState(installId ?? "");
  const q = useQuery(auditQuery({ cursor: paging.cursor, installId }));
  return (
    <>
      <h1>Audit</h1>
      <form
        className="oa-filter"
        onSubmit={(e) => {
          e.preventDefault();
          paging.reset();
          void navigate({
            to: "/audit",
            search: { installId: draft.trim() || undefined },
          });
        }}
      >
        <label>
          Install id{" "}
          <input value={draft} onChange={(e) => setDraft(e.target.value)} />
        </label>{" "}
        <button type="submit" className="oa-link">
          Filter
        </button>
        {installId && (
          <>
            {" "}
            <Link to="/audit" search={{ installId: undefined }}>
              Clear filter
            </Link>
          </>
        )}
      </form>
      {q.isError ? (
        <LoadError
          title="Couldn't load the audit log"
          error={q.error}
          onRetry={() => void q.refetch()}
        />
      ) : q.data && q.data.items.length === 0 ? (
        <p className="oa-placeholder">No audit entries.</p>
      ) : q.data ? (
        <>
          <ul className="oa-audit">
            {q.data.items.map((e) => (
              <li key={e.id} data-outcome={e.outcome}>
                <time>{fmtTime(e.at)}</time> <strong>{e.action}</strong>{" "}
                {e.outcome}
                {e.code && ` (${e.code})`}
                {e.count > 1 && <span data-testid="count"> x{e.count}</span>}
                {" by "}
                {e.actor.label} ({e.actor.kind})
                {e.installId && (
                  <>
                    {" on "}
                    <Link to="/installs/$id" params={{ id: e.installId }}>
                      {e.installId}
                    </Link>
                  </>
                )}
                {e.jobId && (
                  <>
                    {" "}
                    <Link to="/jobs/$id" params={{ id: e.jobId }}>
                      job
                    </Link>
                  </>
                )}
                {e.detail && <code>{JSON.stringify(e.detail)}</code>}
              </li>
            ))}
          </ul>
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
