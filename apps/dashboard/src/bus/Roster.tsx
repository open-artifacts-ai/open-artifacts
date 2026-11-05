// #1293: Agents › Agents: the namespace rail and the roster.
import type { BusAgent } from "@oa/shared";
import {
  Button,
  cn,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ToggleGroup,
  ToggleGroupItem,
  useIsMobile,
} from "@oa/ui/shadcn";
import { useState } from "react";
import { useBusAgents, useBusMachines } from "../api/queries";
import { LoadError } from "../layout/LoadError";
import { Notice } from "../layout/Notice";
import { relativeTime } from "../library/time";
import { muted } from "../settings/ui";
import {
  buildRail,
  type Count,
  inScope,
  listOf,
  parseNamespace,
  parseScope,
  type Scope,
  scopeParam,
  shortName,
} from "./namespaces";
import { BusLink } from "./nav";
import { LIVE_DOWN, QUEUE_LEGEND, StatusBadge } from "./ui";

type Filter = "all" | "live" | "queued";

const ROW =
  "flex min-h-[30px] min-w-0 items-center gap-[6px] rounded-md px-[8px] text-[length:var(--oa-text-sm)] no-underline text-foreground hover:bg-accent aria-[current=true]:bg-accent aria-[current=true]:font-medium";
const LABEL =
  "px-[8px] pt-[10px] pb-[4px] text-[length:var(--oa-text-xs)] text-muted-foreground";

const sameScope = (a: Scope, b: Scope) => scopeParam(a) === scopeParam(b);

function RailRow({
  scope,
  current,
  count,
  title,
  child,
  bold,
  children,
}: {
  scope: Scope;
  current: Scope;
  count: number;
  title?: string;
  child?: boolean;
  bold?: boolean;
  children: React.ReactNode;
}) {
  const on = sameScope(scope, current);
  return (
    <BusLink
      to="/agents"
      search={{ in: scopeParam(scope) }}
      title={title}
      aria-current={on ? "true" : undefined}
      className={cn(ROW, child && "ps-[26px]", bold && "font-semibold")}
    >
      <span className="flex min-w-0 flex-1 flex-col">{children}</span>
      <span className="text-[length:var(--oa-text-xs)] text-muted-foreground tabular-nums">
        {count}
      </span>
    </BusLink>
  );
}

function Rail({ agents, current }: { agents: BusAgent[]; current: Scope }) {
  const [q, setQ] = useState("");
  const rail = buildRail(agents);
  const hit = (s: string) => s.toLowerCase().includes(q.trim().toLowerCase());
  const orgs = rail.orgs
    .map((o) => ({
      ...o,
      namespaces: hit(o.owner)
        ? o.namespaces
        : o.namespaces.filter((n) => hit(n.ns)),
    }))
    .filter((o) => o.namespaces.length > 0);
  const folders = rail.folders.namespaces.filter((n) => hit(n.ns));
  return (
    <aside
      aria-label="Namespaces"
      className="flex min-w-0 flex-col gap-[2px] border-r bg-sidebar p-[var(--oa-space-2)] max-[760px]:border-r-0 max-[760px]:border-b"
    >
      <Input
        type="search"
        aria-label="Find a namespace"
        placeholder="Find a namespace"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="mb-[var(--oa-space-2)] h-[32px] text-[length:var(--oa-text-sm)] md:text-[length:var(--oa-text-sm)]"
      />
      <RailRow scope={{ kind: "all" }} current={current} count={rail.all.total}>
        All agents
      </RailRow>
      {orgs.length > 0 && <p className={`m-0 ${LABEL}`}>By org</p>}
      {orgs.map((o) => (
        <div key={o.owner} className="contents">
          <RailRow
            scope={{ kind: "org", owner: o.owner }}
            current={current}
            count={o.total}
            bold
          >
            <span className="truncate">{o.owner}</span>
          </RailRow>
          {o.namespaces.map((n) => (
            <RailRow
              key={n.ns}
              scope={{ kind: "ns", ns: n.ns }}
              current={current}
              count={n.total}
              title={n.ns}
              child
            >
              <span className="truncate">{n.label}</span>
            </RailRow>
          ))}
        </div>
      ))}
      {folders.length > 0 && (
        <>
          <RailRow
            scope={{ kind: "folders" }}
            current={current}
            count={rail.folders.total}
            bold
          >
            Other folders
          </RailRow>
          {folders.map((n) => (
            <RailRow
              key={n.ns}
              scope={{ kind: "ns", ns: n.ns }}
              current={current}
              count={n.total}
              title={`Folder name only, on ${listOf(n.machines)}`}
              child
            >
              <span className="flex min-w-0 items-center gap-[6px]">
                <span className="truncate">{n.ns}</span>
                {n.machines.length > 1 && (
                  <span className="flex-none rounded-sm bg-[var(--oa-warning-soft)] px-[5px] py-[2px] text-[10px] leading-none font-semibold text-[var(--oa-warning)]">
                    {n.machines.length} machines
                  </span>
                )}
              </span>
              <span className="truncate text-[length:var(--oa-text-xs)] text-muted-foreground">
                on {listOf(n.machines)}
              </span>
            </RailRow>
          ))}
        </>
      )}
      {rail.global.total > 0 && (
        <>
          <p className={`m-0 ${LABEL}`}>Everywhere</p>
          <RailRow
            scope={{ kind: "global" }}
            current={current}
            count={rail.global.total}
            title="Global agents are seen by every namespace"
          >
            global
          </RailRow>
        </>
      )}
    </aside>
  );
}

/** The roster's heading and summary for `scope`. */
function heading(scope: Scope, agents: BusAgent[], all: string[]) {
  const nss = new Set(agents.map((a) => a.namespace)).size;
  const c: Count = {
    total: agents.length,
    live: agents.filter((a) => a.state === "live").length,
  };
  const states = `${c.live} live, ${c.total - c.live} queued`;
  const spread = `${nss} namespace${nss === 1 ? "" : "s"} · ${states}`;
  switch (scope.kind) {
    case "all":
      return { title: "All agents", sub: spread };
    case "org":
      return { title: scope.owner, sub: spread };
    case "folders":
      return { title: "Other folders", sub: spread };
    case "global":
      return {
        title: "Global agents",
        sub: `Seen by every namespace · ${states}`,
      };
    case "ns": {
      const p = parseNamespace(scope.ns);
      return {
        title: shortName(scope.ns, all),
        sub: `${p.kind === "repo" ? `in ${p.owner}` : "Folder name"} · ${c.total} agent${c.total === 1 ? "" : "s"}, ${c.live} live`,
      };
    }
  }
}

function RosterTable({ agents, all }: { agents: BusAgent[]; all: string[] }) {
  const stacked = useIsMobile();
  const status = (a: BusAgent) => (
    <StatusBadge status={a.state === "live" ? "Live" : "Queued"} />
  );
  const says = (a: BusAgent) =>
    a.statusLabel ? (
      <span title={`${a.statusLabel} (reported by the agent)`}>
        {a.statusLabel}
      </span>
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  if (stacked)
    return (
      <ul aria-label="Agents" className="m-0 list-none p-0">
        {agents.map((a) => (
          <li
            key={a.id}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-[var(--oa-space-3)] gap-y-[2px] border-b py-[var(--oa-space-3)] text-[length:var(--oa-text-sm)] last:border-b-0"
          >
            <span className="min-w-0 truncate">
              <span className="font-medium">{a.name}</span>{" "}
              <span className="text-muted-foreground">
                · {shortName(a.namespace, all)}
              </span>
            </span>
            <span className="justify-self-end">{status(a)}</span>
            {a.statusLabel && (
              <span className="col-span-2 text-[length:var(--oa-text-xs)]">
                {says(a)}
              </span>
            )}
            <span className={muted}>{a.machineLabel}</span>
            <span className={`justify-self-end ${muted}`}>
              {relativeTime(a.updatedAt)}
            </span>
          </li>
        ))}
      </ul>
    );
  return (
    <Table aria-label="Agents">
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Agent says</TableHead>
          <TableHead>Machine</TableHead>
          <TableHead>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((a) => (
          <TableRow key={a.id}>
            <TableCell>
              <span className="font-medium">{a.name}</span>{" "}
              <span className="text-muted-foreground" title={a.namespace}>
                · {shortName(a.namespace, all)}
              </span>
            </TableCell>
            <TableCell>{status(a)}</TableCell>
            <TableCell className="max-w-[180px] truncate">{says(a)}</TableCell>
            <TableCell className="text-muted-foreground">
              {a.machineLabel}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {relativeTime(a.updatedAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function Roster({ scope: raw }: { scope?: string }) {
  const agents = useBusAgents();
  const machines = useBusMachines();
  const [filter, setFilter] = useState<Filter>("all");
  const scope = parseScope(raw);
  if (agents.isPending) return <p className={`m-0 ${muted}`}>Loading…</p>;
  if (agents.isError)
    return (
      <LoadError
        title="Couldn't load your agents."
        error={agents.error}
        busy={agents.isFetching}
        onRetry={() => void agents.refetch()}
      />
    );
  const list = agents.data.agents;
  if (!agents.data.live) return <Notice tone="warning">{LIVE_DOWN}</Notice>;
  if (list.length === 0) {
    const noMachine =
      machines.data !== undefined &&
      !machines.data.machines.some((m) => m.revokedAt === null);
    return (
      <div className="grid justify-items-start gap-[var(--oa-space-2)] rounded-lg border p-[var(--oa-space-5)]">
        <p className="m-0 font-medium">
          {noMachine ? "No agents yet" : "No agents running"}
        </p>
        <p className={`m-0 ${muted}`}>
          {noMachine
            ? "Connect a machine first."
            : "Agents appear here while a session on one of your machines is running."}
        </p>
        {noMachine && (
          <Button asChild variant="outline" size="sm">
            <BusLink to="/settings/machines">Go to Machines</BusLink>
          </Button>
        )}
      </div>
    );
  }
  const all = [...new Set(list.map((a) => a.namespace))];
  const inView = list.filter((a) => inScope(a, scope));
  const shown = inView.filter((a) => filter === "all" || a.state === filter);
  const live = inView.filter((a) => a.state === "live").length;
  const h = heading(scope, inView, all);
  return (
    <div className="grid min-w-0 grid-cols-[220px_minmax(0,1fr)] overflow-hidden rounded-lg border max-[760px]:grid-cols-[minmax(0,1fr)]">
      <Rail agents={list} current={scope} />
      <section
        aria-labelledby="oa-roster-h"
        className="grid min-w-0 content-start gap-[var(--oa-space-3)] p-[var(--oa-space-4)]"
      >
        <div className="flex flex-wrap items-end justify-between gap-[var(--oa-space-3)]">
          <div className="grid min-w-0 gap-[2px]">
            <h2
              id="oa-roster-h"
              className="m-0 truncate text-[length:var(--oa-text-md)] font-semibold"
              title={scope.kind === "ns" ? scope.ns : undefined}
            >
              {h.title}
            </h2>
            <p className={`m-0 ${muted}`}>{h.sub}</p>
          </div>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label="Show"
            value={filter}
            onValueChange={(v) => v && setFilter(v as Filter)}
          >
            <ToggleGroupItem value="all">All {inView.length}</ToggleGroupItem>
            <ToggleGroupItem value="live">Live {live}</ToggleGroupItem>
            <ToggleGroupItem value="queued">
              Queued {inView.length - live}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        {shown.length === 0 ? (
          <p className={`m-0 ${muted}`}>No agents here.</p>
        ) : (
          <RosterTable agents={shown} all={all} />
        )}
        <p className={`m-0 ${muted}`}>{QUEUE_LEGEND}</p>
      </section>
    </div>
  );
}
