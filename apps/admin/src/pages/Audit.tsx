import { type AuditEntry, InstallIdSchema } from "@oa/provisioning-contract";
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
import { useCan, useMe } from "../hooks/useEnv";
import { usePaging } from "../hooks/usePaging";
import { LoadError } from "../layout/LoadError";

/**
 * Each action a filter can offer, as written by the API and the provisioner.
 * audit-actions.test.ts checks this against the code that writes them, so an
 * option can't return nothing. Step rows such as upgrade.start aren't offered:
 * job.done and job.failed summarize them.
 */
const VERB: Record<string, string> = {
  "job.accepted": "started a job",
  "job.replayed": "replayed a job",
  "job.refused": "had a job refused",
  "job.canceled": "canceled a job",
  "job.done": "finished a job",
  "job.failed": "had a job fail",
  "authz.refused": "was refused",
  "signin.ok": "signed in",
  "signin.refused": "couldn't sign in",
  "session.logout": "signed out",
  "token.mint": "minted a token",
  "token.used": "used a token",
  "token.revoke": "revoked a token",
  "token.revoke_all": "revoked every token",
  "oauth.grant": "approved an agent",
  "oauth.denied": "denied an agent",
  "oauth.refresh_refused": "had a token refresh refused",
  "oauth.client_expired": "had an agent client expire",
  "test_admin.session": "started a test admin session",
};
export const AUDIT_ACTIONS = Object.keys(VERB);
/**
 * The actions `own` reach writes: its rows are its API calls. A create and an
 * upgrade are both job.accepted (detail.kind tells them apart), and R17
 * matches one exact action.
 */
const OWN_ACTIONS = [
  "job.accepted",
  "job.replayed",
  "job.refused",
  "authz.refused",
  "session.logout",
];
/** Design's sentence verb for a known action; the raw action name otherwise. */
export const actionPhrase = (action: string) =>
  Object.hasOwn(VERB, action) ? VERB[action] : action;

/** The filters' "any" value (Radix Select has no empty value). */
const ANY = "__any";
/** System actors the audit records by label (provisioning-contract/src/system.ts). */
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

/** A row's verb: a job names its install when it has one. */
const rowPhrase = (e: AuditEntry) =>
  `${actionPhrase(e.action)}${e.installId && e.action.startsWith("job.") ? " on" : ""}`;

/** A refusal's verb says the outcome, so its code is the row's detail. */
const isRefusal = (e: AuditEntry) => e.action === "authz.refused";
const hasChip = (e: AuditEntry) => e.outcome !== "ok" && !isRefusal(e);
const detailOf = (e: AuditEntry) =>
  [isRefusal(e) ? e.code : null, detailLine(e.detail)]
    .filter(Boolean)
    .join(" · ");

export function Audit({
  installId,
  actor: actorParam,
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
  // Every row is this principal's, so an actor filter could only hide them.
  const ownReach = me.data?.principal === "test-admin";
  const actor = ownReach ? undefined : actorParam;
  const actions = ownReach ? OWN_ACTIONS : Object.keys(VERB);
  // A refused call writes an audit row, so don't ask without the capability.
  const tokens = useQuery({
    ...tokensQuery(),
    retry: false,
    enabled: useCan("R20"),
  });
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
      {me.data && (
        <p className="oa-sub">
          {me.data.principal === "test-admin"
            ? "Test admin: only your own rows."
            : "Every admin action, agent token call and sign-in. Newest first."}
        </p>
      )}
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
        {!ownReach && (
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
        )}
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
            {action && !actions.includes(action) && (
              <SelectItem value={action}>{actionPhrase(action)}</SelectItem>
            )}
            {actions.map((a) => (
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
                      {rowPhrase(e)}
                      {e.count > 1 && (
                        <span data-testid="count"> {e.count} times</span>
                      )}
                    </TableCell>
                    <TableCell
                      className={e.installId ? undefined : "oa-audit-none"}
                    >
                      {e.installId ? (
                        <Link to="/installs/$id" params={{ id: e.installId }}>
                          {slugs.get(e.installId) ?? e.installId}
                        </Link>
                      ) : (
                        <span className="oa-note">–</span>
                      )}
                    </TableCell>
                    <TableCell className="oa-audit-detail">
                      {hasChip(e) && (
                        <span className="oa-chip oa-chip-danger">
                          {e.outcome}
                          {e.code ? ": " : ""}
                          {e.code && <span className="oa-code">{e.code}</span>}
                        </span>
                      )}
                      {hasChip(e) && (detailOf(e) || e.jobId) ? " " : ""}
                      {detailOf(e)}
                      {e.jobId && (
                        <>
                          {detailOf(e) ? " · " : ""}
                          <Link to="/jobs/$id" params={{ id: e.jobId }}>
                            job{" "}
                            <span className="oa-code">{shortId(e.jobId)}</span>
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
