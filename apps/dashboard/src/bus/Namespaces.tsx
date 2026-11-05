// #1293: Agents › Namespaces, and one namespace's page.
import type { BusAgent, BusRole } from "@oa/shared";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@oa/ui/shadcn";
import { useBusAgents, useBusRoles } from "../api/queries";
import { LoadError } from "../layout/LoadError";
import { Notice } from "../layout/Notice";
import { muted, SettingsCard, STACK } from "../settings/ui";
import { shortDate } from "./format";
import { buildRail, listOf, parseNamespace, shortName } from "./namespaces";
import { BusLink, LINK } from "./nav";
import { LIVE_DOWN } from "./ui";

/** "bus-lead points at pi-3." / "reviewer is vacant. Its holder isn't open here." */
export function RoleSentence({ role }: { role: BusRole }) {
  return role.vacant || role.holderName === null ? (
    <>
      <b>{role.name}</b> is vacant. Its holder isn't open here.
    </>
  ) : (
    <>
      <b>{role.name}</b> points at <b>{role.holderName}</b>.
    </>
  );
}

function NamespacePage({
  ns,
  agents,
  roles,
}: {
  ns: string;
  agents: BusAgent[];
  roles: BusRole[] | undefined;
}) {
  const all = [...new Set(agents.map((a) => a.namespace))];
  const here = agents.filter((a) => a.namespace === ns);
  const live = here.filter((a) => a.state === "live").length;
  const p = parseNamespace(ns);
  const machines = [...new Set(here.map((a) => a.machineLabel))].sort();
  const name = shortName(ns, all);
  const mine = (roles ?? []).filter((r) => r.namespace === ns);
  const count = `${here.length} agent${here.length === 1 ? "" : "s"}, ${live} live`;
  return (
    <div className={STACK}>
      <p className="m-0 text-[length:var(--oa-text-sm)]">
        <BusLink to="/agents/namespaces" className={LINK}>
          All namespaces
        </BusLink>
      </p>
      <SettingsCard
        id="oa-ns-h"
        title={name}
        subtitle={
          p.kind === "repo"
            ? `in ${p.owner} · ${count}`
            : `Folder name, no git remote · ${count}`
        }
      >
        {p.kind === "folder" && machines.length > 1 && (
          <Notice tone="warning">
            <span>
              Folders called <b>{ns}</b> on {machines.length} machines share
              this namespace, so their agents can see each other.
            </span>
          </Notice>
        )}
        <dl className="m-0 grid grid-cols-[160px_minmax(0,1fr)] items-center gap-x-[var(--oa-space-4)] gap-y-[var(--oa-space-3)] text-[length:var(--oa-text-sm)] max-[600px]:grid-cols-[minmax(0,1fr)] max-[600px]:gap-y-[4px]">
          <dt className="text-muted-foreground">
            {p.kind === "repo" ? "Full path" : "Comes from"}
          </dt>
          <dd className="m-0 min-w-0 break-all font-mono text-[length:var(--oa-text-xs)]">
            {p.kind === "repo" ? ns : `on ${listOf(machines)}`}
          </dd>
        </dl>
        <p className="m-0 text-[length:var(--oa-text-sm)]">
          <BusLink to="/agents" search={{ in: `ns:${ns}` }} className={LINK}>
            See its agents
          </BusLink>
        </p>
      </SettingsCard>
      <SettingsCard
        id="oa-ns-roles-h"
        title="Roles in this namespace"
        subtitle="From Roles and access. Change them there."
      >
        {roles === undefined ? (
          <p className={`m-0 ${muted}`}>Loading…</p>
        ) : mine.length === 0 ? (
          <p className={`m-0 ${muted}`}>No role in {name} yet.</p>
        ) : (
          <ul className="m-0 grid list-none gap-[var(--oa-space-3)] p-0">
            {mine.map((r) => (
              <li
                key={r.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-[var(--oa-space-4)] text-[length:var(--oa-text-sm)]"
              >
                <span>
                  <RoleSentence role={r} />
                </span>
                <span className={muted}>Set {shortDate(r.setAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
    </div>
  );
}

export function NamespacesTab({ ns }: { ns?: string }) {
  const agents = useBusAgents();
  const roles = useBusRoles();
  if (agents.isPending) return <p className={`m-0 ${muted}`}>Loading…</p>;
  if (agents.isError)
    return (
      <LoadError
        title="Couldn't load your namespaces."
        error={agents.error}
        busy={agents.isFetching}
        onRetry={() => void agents.refetch()}
      />
    );
  if (!agents.data.live) return <Notice tone="warning">{LIVE_DOWN}</Notice>;
  const list = agents.data.agents;
  if (ns)
    return (
      <NamespacePage
        ns={ns}
        agents={list}
        roles={roles.data?.live ? roles.data.roles : undefined}
      />
    );
  const rail = buildRail(list);
  const rows = [
    ...rail.orgs.flatMap((o) =>
      o.namespaces.map((n) => ({ ...n, where: o.owner })),
    ),
    ...rail.folders.namespaces.map((n) => ({
      ...n,
      where: `Folder on ${listOf(n.machines)}`,
    })),
  ];
  if (rows.length === 0)
    return (
      <p className={`m-0 ${muted}`}>
        Namespaces show up here while an agent is running in one.
      </p>
    );
  return (
    <SettingsCard
      id="oa-nss-h"
      title="Namespaces"
      subtitle="Where your running agents started. A repo's namespace comes from its git remote; any other folder uses its name."
    >
      <Table aria-label="Namespaces">
        <TableHeader>
          <TableRow>
            <TableHead>Namespace</TableHead>
            <TableHead>In</TableHead>
            <TableHead className="text-right">Agents</TableHead>
            <TableHead className="text-right">Live</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((n) => (
            <TableRow key={n.ns}>
              <TableCell className="font-medium">
                <BusLink
                  to="/agents/namespaces"
                  search={{ ns: n.ns }}
                  title={n.ns}
                  className={LINK}
                >
                  {n.label}
                </BusLink>
              </TableCell>
              <TableCell className="text-muted-foreground">{n.where}</TableCell>
              <TableCell className="text-right tabular-nums">
                {n.total}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {n.live}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SettingsCard>
  );
}
