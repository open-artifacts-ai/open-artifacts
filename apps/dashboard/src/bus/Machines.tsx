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
import { ApiClientError } from "../api/client";
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
          On that computer, ask any AI agent to set up Open Artifacts and say
          yes when it asks about reaching agents on other machines.
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
  live: number | null;
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
          Live agents {liveText(live)} · Last used {lastUsed(m)} · Added{" "}
          {shortDate(m.createdAt)}
        </span>
        <span className="justify-self-end">{revoke}</span>
      </li>
    );
  return (
    <TableRow>
      <TableCell className="font-medium">{m.label}</TableCell>
      <TableCell>{badge}</TableCell>
      <TableCell>{liveText(live)}</TableCell>
      <TableCell>{lastUsed(m)}</TableCell>
      <TableCell>{shortDate(m.createdAt)}</TableCell>
      <TableCell className="text-right">{revoke}</TableCell>
    </TableRow>
  );
}

export function Machines() {
  useDocumentTitle("Machines");
  const q = useBusMachines();
  const agents = useBusAgents();
  const revoke = useRevokeBusMachine();
  const stacked = useIsMobile();
  const [pick, setPick] = useState<BusMachine | null>(null);
  /** Revoked, but its open connection didn't close: Try again reopens the dialog. */
  const [partial, setPartial] = useState<BusMachine | null>(null);
  const agentList = agents.data?.live ? agents.data.agents : undefined;
  const machines = q.data?.machines ?? [];
  const unknown =
    machines.some((m) => m.revokedAt === null && m.connected === null) ||
    (agents.data?.live === false && machines.some((m) => m.revokedAt === null));

  const doRevoke = async (m: BusMachine) => {
    setPick(null);
    setPartial(null);
    try {
      await revoke.mutateAsync(m.id);
      toast({ title: `${m.label} revoked.`, tone: "success" });
    } catch (e) {
      if (e instanceof ApiClientError && e.status >= 500) setPartial(m);
      else
        toast({
          title:
            e instanceof ApiClientError
              ? e.message
              : "Couldn't revoke the machine.",
          tone: "danger",
        });
    }
  };

  const pickLive = pick ? liveOn(pick, agentList) : null;
  return (
    <div className={STACK}>
      {partial && (
        <Notice
          tone="danger"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPick(partial)}
            >
              Try again
            </Button>
          }
        >
          {partial.label} is revoked and can't reconnect, but its open
          connection didn't close. Try again to close it.
        </Notice>
      )}
      {unknown && <Notice tone="warning">{LIVE_DOWN}</Notice>}
      <SettingsCard
        id="oa-machines-h"
        title="Your machines"
        subtitle={machines.length ? machinesSummary(machines) : undefined}
        action={
          machines.length > 0 ? (
            <ConnectLink label="Connect a machine" />
          ) : undefined
        }
      >
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
          <Empty />
        ) : stacked ? (
          <ul aria-label="Your machines" className="m-0 list-none p-0">
            {machines.map((m) => (
              <Row
                key={m.id}
                m={m}
                live={liveOn(m, agentList)}
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
                <TableHead>Live agents</TableHead>
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
                  live={liveOn(m, agentList)}
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
