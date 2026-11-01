import { InstallIdSchema } from "@oa/shared/provisioning";
import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@oa/ui/shadcn";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { auditQuery, installQuery, tokensQuery } from "../api/queries";
import { Pager } from "../components/Bits";
import { fmtDayClock, shortId } from "../components/labels";
import { useMe } from "../hooks/useEnv";
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

/** The filters' "any" value (Radix Select has no empty value). */
const ANY = "__any";
/** System actors the audit records by label (shared/provisioning/system.ts). */
const SYSTEM_ACTORS: [string, string][] = [["scheduler", "Scheduler"]];
const PROVIDER: Record<string, string> = { google: "Google", email: "Email" };
const text = (v: unknown) =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The plain detail line from the mock ("to 0.77.1", "Team, Google",
 * "via MCP · Claude Code"), built from the fields people read; never raw JSON.
 */
export function detailLine(detail: Record<string, unknown> | null): string {
  if (!detail) return "";
  const parts: string[] = [];
  const args = isObj(detail.args) ? detail.args : {};
  if (detail.kind === "create") {
    const auth = isObj(args.auth) ? args.auth : {};
    const providers = Array.isArray(auth.providers)
      ? auth.providers.map((p) => PROVIDER[String(p)] ?? String(p))
      : [];
    const tier = text(args.tier);
    const bits = [tier && cap(tier), ...providers].filter(Boolean);
    if (bits.length) parts.push(bits.join(", "));
  } else {
    const version = text(args.version) ?? text(detail.version);
    if (version) parts.push(`to ${version}`);
  }
  for (const v of [args.reason, detail.reason, detail.stage, detail.note]) {
    const t = text(v);
    if (t) parts.push(t);
  }
  if (detail.surface === "mcp") {
    parts.push("via MCP");
    const client = text(detail.client);
    if (client) parts.push(client);
  }
  return parts.join(" · ");
}

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
  const me = useMe();
  const tokens = useQuery({ ...tokensQuery(), retry: false });
  const valid = !installId || InstallIdSchema.safeParse(installId).success;
  const [bad, setBad] = useState(false);
  const q = useQuery({
    ...auditQuery({ cursor: paging.cursor, installId, actor, action }),
    enabled: valid,
  });
  // Target shows the install's slug; the entry carries only its id.
  const ids = [
    ...new Set((q.data?.items ?? []).flatMap((e) => e.installId ?? [])),
  ];
  const slugs = useQueries({
    queries: ids.map((id) => ({ ...installQuery(id), staleTime: 60_000 })),
    combine: (rs) =>
      new Map(ids.map((id, i) => [id, rs[i]?.data?.slug] as const)),
  });
  // Actor choices (R17 matches the label exactly, or `token:<id>`): you, the
  // people seen on this page, the Scheduler and every agent token.
  const actors = new Map<string, string>();
  if (me.data?.email) actors.set(me.data.email, me.data.email);
  for (const e of q.data?.items ?? [])
    if (e.actor.kind !== "token" && e.actor.kind !== "system")
      actors.set(e.actor.label, e.actor.label);
  for (const [v, l] of SYSTEM_ACTORS) actors.set(v, l);
  for (const t of tokens.data?.items ?? [])
    actors.set(`token:${t.id}`, `token: ${t.label}`);
  if (actor && !actors.has(actor)) actors.set(actor, actor);
  const go = (s: { installId?: string; actor?: string; action?: string }) => {
    paging.reset();
    void navigate({ to: "/audit", search: s });
  };
  return (
    <>
      <h1>Audit log</h1>
      <p className="oa-sub">
        Every admin action, agent token call and sign-in. Newest first.
      </p>
      <form
        className="oa-tools oa-audit-tools"
        onSubmit={(e) => {
          // Enter in the Install search applies it.
          e.preventDefault();
          const id = draft.trim();
          const invalid = id !== "" && !InstallIdSchema.safeParse(id).success;
          setBad(invalid);
          if (invalid) return;
          go({ installId: id || undefined, actor, action });
        }}
      >
        <Select
          value={actor || ANY}
          onValueChange={(v) =>
            go({ installId, actor: v === ANY ? undefined : v, action })
          }
        >
          <SelectTrigger aria-label="Actor" className="oa-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value={ANY}>Any actor</SelectItem>
            {[...actors].map(([v, l]) => (
              <SelectItem key={v} value={v}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={action || ANY}
          onValueChange={(v) =>
            go({ installId, actor, action: v === ANY ? undefined : v })
          }
        >
          <SelectTrigger aria-label="Action" className="oa-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value={ANY}>Any action</SelectItem>
            {action && !Object.hasOwn(VERB, action) && (
              <SelectItem value={action}>{action}</SelectItem>
            )}
            {Object.keys(VERB).map((a) => (
              <SelectItem key={a} value={a}>
                {actionPhrase(a)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="oa-search">
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
          <Input
            type="search"
            aria-label="Install"
            placeholder="Install"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </span>
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
                          {slugs.get(e.installId) ?? e.installId}
                        </Link>
                      ) : (
                        ""
                      )}
                    </TableCell>
                    <TableCell className="oa-audit-detail">
                      {detailLine(e.detail)}
                      {e.jobId && (
                        <>
                          {detailLine(e.detail) ? " · " : ""}
                          <Link to="/jobs/$id" params={{ id: e.jobId }}>
                            job {shortId(e.jobId)}
                          </Link>
                        </>
                      )}
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
