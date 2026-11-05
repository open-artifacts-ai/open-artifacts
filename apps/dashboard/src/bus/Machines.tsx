// #1293: Settings › Machines (Design's "Bus pages in the dashboard", option 1).
import type { BusAgent, BusMachine } from "@oa/shared";
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useIsMobile,
} from "@oa/ui/shadcn";
import { useState } from "react";
import {
  useBusAgents,
  useBusMachines,
  useRevokeBusMachine,
} from "../api/queries";
import { LoadError } from "../layout/LoadError";
import { Notice } from "../layout/Notice";
import { toast } from "../layout/toast";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { ConfirmDialog } from "../settings/ConfirmDialog";
import { muted, SettingsCard, STACK } from "../settings/ui";
import { dayTime, shortDate } from "./format";
import {
  APPROVE_PATH,
  LIVE_DOWN,
  liveAgents,
  type Status,
  StatusBadge,
} from "./ui";

/** Live, Offline, Unknown (the bus couldn't be asked) or Revoked. */
export const machineStatus = (m: BusMachine): Status =>
  m.revokedAt !== null
    ? "Revoked"
    : m.connected === null
      ? "Unknown"
      : m.connected
        ? "Live"
        : "Offline";

/** Live agents on `m`, or null when that can't be known (revoked rows show None). */
export function liveOn(
  m: BusMachine,
  agents: BusAgent[] | undefined,
): number | null {
  if (m.revokedAt !== null) return 0;
  if (agents === undefined || m.connected === null) return null;
  return agents.filter((a) => a.machineId === m.id && a.state === "live")
    .length;
}

/** "2 live", never a raw count of rows. */
export const machinesSummary = (ms: BusMachine[]) =>
  `${ms.filter((m) => m.revokedAt === null && m.connected === true).length} live`;

const lastUsed = (m: BusMachine) =>
  m.lastUsedAt === null ? "Never" : dayTime(m.lastUsedAt);
const liveText = (n: number | null) =>
  n === null ? "—" : n === 0 ? "None" : String(n);

function ConnectLink({ label }: { label: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      <a href={APPROVE_PATH} target="_blank" rel="noopener">
        {label}
      </a>
    </Button>
  );
}

function Empty() {
  return (
    <div className="grid gap-[var(--oa-space-3)]">
      <div className="grid gap-[2px]">
        <p className="m-0 font-medium">No machines yet</p>
        <p className={`m-0 ${muted}`}>
          Connect a computer so the AI agents on it can reach your agents on
          your other machines.
        </p>
      </div>
      <ol className="m-0 grid list-decimal gap-[var(--oa-space-2)] ps-[var(--oa-space-5)] text-[length:var(--oa-text-sm)]">
        <li>
          Ask any AI agent to set up the Open Artifacts bus client and connect
          it to <span className="font-mono">{location.host}</span>.
        </li>
        <li>
          It prints a code. Type it at{" "}
          <span className="font-mono">
            {location.host}
            {APPROVE_PATH}
          </span>
          , then approve the machine. <ConnectLink label="Enter a code" />
        </li>
      </ol>
    </div>
  );
}

function Row({
  m,
  live,
  stacked,
  onRevoke,
}: {
  m: BusMachine;
  /** undefined: revoke-only, where live agents aren't listed (#1447). */
  live: number | null | undefined;
  stacked: boolean;
  onRevoke: () => void;
}) {
  const badge = (
    <StatusBadge
      status={machineStatus(m)}
      text={
        m.revokedAt === null ? undefined : `Revoked ${shortDate(m.revokedAt)}`
      }
    />
  );
  const revoke = m.revokedAt === null && (
    <Button
      variant="outline"
      size="sm"
      aria-label={`Revoke ${m.label}`}
      onClick={onRevoke}
    >
      Revoke
    </Button>
  );
  if (stacked)
    return (
      <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-[var(--oa-space-3)] gap-y-[2px] border-b py-[var(--oa-space-3)] last:border-b-0">
        <span className="min-w-0 truncate font-medium">{m.label}</span>
        <span className="justify-self-end">{badge}</span>
        <span className={muted}>
          {live !== undefined && `Live agents ${liveText(live)} · `}Last used{" "}
          {lastUsed(m)} · Added {shortDate(m.createdAt)}
        </span>
        <span className="justify-self-end">{revoke}</span>
      </li>
    );
  return (
    <TableRow>
      <TableCell className="font-medium">{m.label}</TableCell>
      <TableCell>{badge}</TableCell>
      {live !== undefined && <TableCell>{liveText(live)}</TableCell>}
      <TableCell>{lastUsed(m)}</TableCell>
      <TableCell>{shortDate(m.createdAt)}</TableCell>
      <TableCell className="text-right">{revoke}</TableCell>
    </TableRow>
  );
}

/** Revoked in the reloaded list, but the request failed: its connection didn't close. */
export const revokePartialLine = (label: string) =>
  `${label} is revoked and can't reconnect, but its open connection didn't close. Try again to close it.`;

/** Design's copy for a failed revoke the reloaded list doesn't show revoked. */
export const revokeFailedLine = (label: string) =>
  `${label} may not be revoked yet, and its connection may still be open. Try again.`;

/** The capped line, as Settings › Connections says it. */
export const REVOKE_ONLY_LINE =
  "You can't connect new machines. You can revoke these.";

export function Machines({ revokeOnly = false }: { revokeOnly?: boolean }) {
  useDocumentTitle("Machines");
  const q = useBusMachines();
  // GET bus/agents is 404 without canConnect: revoke-only never asks.
  const agents = useBusAgents(!revokeOnly);
  const revoke = useRevokeBusMachine();
  const stacked = useIsMobile();
  const [pick, setPick] = useState<BusMachine | null>(null);
  /**
   * A failed revoke, by what the reloaded list says: "partial" when it shows
   * the machine revoked (its connection didn't close), else "maybe". Try
   * again reopens the dialog either way.
   */
  const [failed, setFailed] = useState<{
    m: BusMachine;
    revoked: boolean;
  } | null>(null);
  const agentList = agents.data?.live ? agents.data.agents : undefined;
  const liveFor = (m: BusMachine) =>
    revokeOnly ? undefined : liveOn(m, agentList);
  const machines = q.data?.machines ?? [];
  const unknown =
    machines.some((m) => m.revokedAt === null && m.connected === null) ||
    (!revokeOnly &&
      agents.data?.live === false &&
      machines.some((m) => m.revokedAt === null));

  const doRevoke = async (m: BusMachine) => {
    setPick(null);
    setFailed(null);
    try {
      await revoke.mutateAsync(m.id);
      toast({ title: `${m.label} revoked.`, tone: "success" });
    } catch {
      // A failure says nothing sure about the revoke: the reloaded list does.
      const after = await q.refetch();
      const row = after.data?.machines.find((x) => x.id === m.id);
      setFailed({ m, revoked: row !== undefined && row.revokedAt !== null });
    }
  };

  const pickLive = pick ? liveOn(pick, agentList) : null;
  return (
    <div className={STACK}>
      {failed && (
        <Notice
          tone="danger"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPick(failed.m)}
            >
              Try again
            </Button>
          }
        >
          {failed.revoked
            ? revokePartialLine(failed.m.label)
            : revokeFailedLine(failed.m.label)}
        </Notice>
      )}
      {unknown && <Notice tone="warning">{LIVE_DOWN}</Notice>}
      <SettingsCard
        id="oa-machines-h"
        title="Your machines"
        subtitle={machines.length ? machinesSummary(machines) : undefined}
        action={
          !revokeOnly && machines.length > 0 ? (
            <ConnectLink label="Connect a machine" />
          ) : undefined
        }
      >
        {revokeOnly && <p className={`m-0 ${muted}`}>{REVOKE_ONLY_LINE}</p>}
        {q.isPending ? (
          <p className={`m-0 ${muted}`}>Loading…</p>
        ) : q.isError ? (
          <LoadError
            title="Couldn't load your machines."
            error={q.error}
            busy={q.isFetching}
            onRetry={() => void q.refetch()}
          />
        ) : machines.length === 0 ? (
          revokeOnly ? (
            <p className={`m-0 ${muted}`}>No machines left to revoke.</p>
          ) : (
            <Empty />
          )
        ) : stacked ? (
          <ul aria-label="Your machines" className="m-0 list-none p-0">
            {machines.map((m) => (
              <Row
                key={m.id}
                m={m}
                live={liveFor(m)}
                stacked
                onRevoke={() => setPick(m)}
              />
            ))}
          </ul>
        ) : (
          <Table aria-label="Your machines">
            <TableHeader>
              <TableRow>
                <TableHead>Machine</TableHead>
                <TableHead>Status</TableHead>
                {!revokeOnly && <TableHead>Live agents</TableHead>}
                <TableHead>Last used</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {machines.map((m) => (
                <Row
                  key={m.id}
                  m={m}
                  live={liveFor(m)}
                  stacked={false}
                  onRevoke={() => setPick(m)}
                />
              ))}
            </TableBody>
          </Table>
        )}
        {machines.length > 0 && (
          <p className={`m-0 ${muted}`}>
            Machines you approved can reach each other's agents, as you. Only
            you see this list.
          </p>
        )}
      </SettingsCard>
      {pick && (
        <ConfirmDialog
          open
          onClose={() => setPick(null)}
          title={`Revoke "${pick.label}"?`}
          body={
            <p>
              Its connection closes at once and{" "}
              {pickLive
                ? `its ${liveAgents(pickLive)} ${pickLive === 1 ? "leaves" : "leave"}`
                : "its agents leave"}{" "}
              the list. Messages to them are refused. This can't be undone.
            </p>
          }
          confirm="Revoke"
          danger
          onConfirm={() => void doRevoke(pick)}
        />
      )}
    </div>
  );
}
