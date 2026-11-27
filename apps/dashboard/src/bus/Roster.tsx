// #1293: Agents › Agents: the namespace rail and the roster.
import { type BusAgent, type BusRole, busAgentStarting } from "@oa/shared";
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
import {
  useAwayRoleAction,
  useBusAgents,
  useBusMachines,
  useBusRoles,
} from "../api/queries";
import { LoadError } from "../layout/LoadError";
import { Notice } from "../layout/Notice";
import { relativeTime } from "../library/time";
import { muted } from "../settings/ui";
import { AgentApp, agentLocation, appName } from "./AgentApp";
import {
  buildRail,
  type Count,
  globalsFrom,
  globalsLine,
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

const agentLabel = (a: BusAgent) =>
  a.pendingRole || (a.privateSessionName && !a.role)
    ? `Session on ${a.machineLabel}`
    : (a.role ?? a.name);

function awayAge(since?: string) {
  const minutes = since
    ? Math.floor((Date.now() - Date.parse(since)) / 60000)
    : NaN;
  if (!Number.isFinite(minutes)) return "away";
  if (minutes < 60) return `away ${Math.max(0, minutes)} min`;
  if (minutes < 1440) return `away ${Math.floor(minutes / 60)} h`;
  return `away ${Math.floor(minutes / 1440)} d`;
}

function AwayName({
  role,
  agents,
  onFreed,
}: {
  role: BusRole;
  agents: BusAgent[];
  onFreed: (name: string) => void;
}) {
  const action = useAwayRoleAction();
  const [mode, setMode] = useState<"move" | "free" | null>(null);
  const [targetId, setTargetId] = useState("");
  const targets = agents.filter(
    (a) => a.state === "live" && (a.global || a.namespace === role.namespace),
  );
  const submit = async (id: string | null) => {
    if (!role.agentId || action.isPending) return;
    try {
      await action.mutateAsync({
        roleId: role.id,
        holderId: role.agentId,
        targetId: id,
      });
      if (id === null) onFreed(role.name);
    } catch {
      /* The mutation shows the failure and refreshes stale rows. */
    }
  };
  const cancel = (
    <Button
      size="sm"
      variant="ghost"
      disabled={action.isPending}
      onClick={() => {
        setMode(null);
        setTargetId("");
      }}
    >
      Cancel
    </Button>
  );
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <div className="mr-auto">
        <b>{role.name}</b>
        <div className={muted}>
          {[
            role.awayMachine &&
              `on ${agentLocation(role.awayMachine.split(".")[0])}`,
            awayAge(role.awaySince),
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
      {mode === null && (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={!targets.length}
            onClick={() => setMode("move")}
          >
            Move to…
          </Button>
          <Button size="sm" variant="outline" onClick={() => setMode("free")}>
            Free this name
          </Button>
        </>
      )}
      {mode === "move" && (
        <div className="flex basis-full flex-wrap items-center gap-2">
          <select
            aria-label={`Move ${role.name} to`}
            value={targetId}
            disabled={action.isPending}
            onChange={(e) => setTargetId(e.target.value)}
          >
            <option disabled value="">
              Choose a live session
            </option>
            {targets.map((a) => (
              <option key={a.id} value={a.id}>
                {appName(a)} on {agentLocation(a.machineLabel.split(".")[0])}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            disabled={
              action.isPending || !targets.some((a) => a.id === targetId)
            }
            onClick={() => void submit(targetId)}
          >
            Move {role.name} here
          </Button>
          {cancel}
          <p className={`m-0 basis-full ${muted}`}>
            Its open asks, mentions and follows move too.
          </p>
        </div>
      )}
      {mode === "free" && (
        <div className="flex basis-full flex-wrap items-center gap-2">
          <p className="m-0 basis-full">
            Free {role.name}? It leaves the @ list. Another session can take the
            name without inheriting its asks or mentions.
          </p>
          <Button
            size="sm"
            disabled={action.isPending}
            onClick={() => void submit(null)}
          >
            Free it
          </Button>
          {cancel}
        </div>
      )}
    </li>
  );
}

function RosterTable({ agents, all }: { agents: BusAgent[]; all: string[] }) {
  const stacked = useIsMobile();
  // agy S2b: a starting session's label is the bus's, shown as its status.
  const status = (a: BusAgent) => (
    <StatusBadge
      status={
        busAgentStarting(a)
          ? "Starting"
          : a.state === "live"
            ? "Live"
            : "Queued"
      }
    />
  );
  const says = (a: BusAgent) =>
    a.statusLabel && !busAgentStarting(a) ? (
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
              <span className="font-medium">{agentLabel(a)}</span>{" "}
              <span className="text-muted-foreground">
                · {shortName(a.namespace, all)}
              </span>
            </span>
            <span className="justify-self-end">{status(a)}</span>
            <span className="col-span-2 text-[length:var(--oa-text-xs)]">
              <AgentApp a={a} />
            </span>
            {a.statusLabel && !busAgentStarting(a) && (
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
  // The App column shows when the table has room; narrower (1240px with the
  // sidebar open), the app sits under the agent's name so "Updated" stays in view.
  const wide = "hidden @min-[840px]/roster:table-cell";
  return (
    <div className="@container/roster">
      <Table aria-label="Agents">
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead className={wide}>App</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Agent says</TableHead>
            <TableHead>Machine</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {agents.map((a) => (
            <TableRow key={a.id}>
              <TableCell className="max-w-[220px] whitespace-normal @min-[840px]/roster:max-w-none @min-[840px]/roster:whitespace-nowrap">
                <span className="font-medium">{agentLabel(a)}</span>{" "}
                <span className="text-muted-foreground" title={a.namespace}>
                  · {shortName(a.namespace, all)}
                </span>
                <span className="mt-[2px] flex text-[length:var(--oa-text-xs)] @min-[840px]/roster:hidden">
                  <AgentApp a={a} />
                </span>
              </TableCell>
              <TableCell className={wide}>
                <AgentApp a={a} />
              </TableCell>
              <TableCell>{status(a)}</TableCell>
              <TableCell className="max-w-[140px] truncate @min-[840px]/roster:max-w-[180px]">
                {says(a)}
              </TableCell>
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
    </div>
  );
}

export function Roster({ scope: raw }: { scope?: string }) {
  const agents = useBusAgents();
  const machines = useBusMachines();
  const roles = useBusRoles();
  const [freed, setFreed] = useState<string | null>(null);
  const confirmation = freed && (
    <p role="status" className={`m-0 ${muted}`}>
      {freed} is free
    </p>
  );
  const [filter, setFilter] = useState<Filter>("all");
  const scope = parseScope(raw);
  if (agents.isPending || roles.isPending)
    return <p className={`m-0 ${muted}`}>Loading…</p>;
  if (agents.isError)
    return (
      <LoadError
        title="Couldn't load your agents."
        error={agents.error}
        busy={agents.isFetching}
        onRetry={() => void agents.refetch()}
      />
    );
  if (roles.isError)
    return (
      <LoadError
        title="Couldn't load held names."
        error={roles.error}
        busy={roles.isFetching}
        onRetry={() => void roles.refetch()}
      />
    );
  const list = agents.data.agents;
  if (!agents.data.live) return <Notice tone="warning">{LIVE_DOWN}</Notice>;
  const away = roles.data.roles.filter(
    (r) =>
      r.awayHolder &&
      r.agentId &&
      inScope({ namespace: r.namespace, global: false }, scope),
  );
  if (list.length === 0 && away.length === 0) {
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
        {confirmation}
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
        {away.length > 0 && filter === "all" && (
          <section aria-label="Names held by away sessions">
            <h3 className={`m-0 font-semibold ${LABEL}`}>
              Names held by away sessions
            </h3>
            <ul className="m-0 list-none divide-y p-0">
              {away.map((role) => (
                <AwayName
                  key={role.id}
                  role={role}
                  agents={list}
                  onFreed={setFreed}
                />
              ))}
            </ul>
          </section>
        )}
        {confirmation}
        {scope.kind === "ns" && globalsFrom(list, scope.ns) > 0 && (
          <p className={`m-0 ${muted}`}>
            {globalsLine(globalsFrom(list, scope.ns))}
          </p>
        )}
        <p className={`m-0 ${muted}`}>{QUEUE_LEGEND}</p>
      </section>
    </div>
  );
}
