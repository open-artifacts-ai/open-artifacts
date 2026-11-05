// #1293: Agents › Roles and access (#1296 roles, #1372 proposals). The
// Access card waits for grants (#1346); confirming a proposal here waits for
// #1444, so a proposal points at the link the agent gave.
import type { BusAgent, BusRole, BusRoleProposal } from "@oa/shared";
import {
  Button,
  Input,
  Label,
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
  useBusRoles,
  useDeleteBusRole,
  usePutBusRole,
} from "../api/queries";
import { LoadError } from "../layout/LoadError";
import { Modal } from "../layout/Modal";
import { Notice } from "../layout/Notice";
import { relativeTime } from "../library/time";
import { ConfirmDialog } from "../settings/ConfirmDialog";
import { OptionSelect } from "../settings/OptionSelect";
import { errorText, muted, SettingsCard, STACK } from "../settings/ui";
import { shortDate } from "./format";
import { shortName } from "./namespaces";
import { LIVE_DOWN } from "./ui";

/** PUT R.busRoles refusals (409 details.reason) as plain lines. */
export const ROLE_REFUSALS: Record<string, string> = {
  name_taken: "That name is taken in this namespace. Pick another.",
  agent_not_open: "That agent isn't open in this namespace anymore.",
  role_limit: "You have the most roles allowed. Remove one first.",
  no_bus: "Connect a machine first.",
};
const INVALID = "Use lowercase letters, numbers, dots, dashes or underscores.";

export function roleError(e: unknown): string {
  if (e instanceof ApiClientError) {
    const reason = (e.details as { reason?: unknown } | undefined)?.reason;
    if (typeof reason === "string" && ROLE_REFUSALS[reason])
      return ROLE_REFUSALS[reason];
    if (e.code === "bad_request") return INVALID;
  }
  return "That didn't save. Try again.";
}

/** The pending proposals whose link still works. */
export const pending = (ps: BusRoleProposal[], now = Date.now()) =>
  ps.filter((p) => p.status === "pending" && Date.parse(p.expiresAt) > now);

function ProposalSentence({ p, all }: { p: BusRoleProposal; all: string[] }) {
  const where = shortName(p.namespace, all);
  if (p.action === "clear")
    return (
      <>
        Remove <b>{p.name}</b> in {where}.
      </>
    );
  return (
    <>
      Point <b>{p.name}</b> in {where} at <b>{p.agentName}</b>
      {p.priorHolderName ? (
        <>
          {" "}
          (now <b>{p.priorHolderName}</b>)
        </>
      ) : null}
      .
    </>
  );
}

function RoleDialog({
  role,
  agents,
  onClose,
}: {
  /** null: Add a role. */
  role: BusRole | null;
  agents: BusAgent[];
  onClose: () => void;
}) {
  const put = usePutBusRole();
  const all = [...new Set(agents.map((a) => a.namespace))].sort();
  const [name, setName] = useState(role?.name ?? "");
  const [ns, setNs] = useState<string | null>(role?.namespace ?? null);
  const [holder, setHolder] = useState<string | null>(role?.agentId ?? null);
  const [error, setError] = useState<string | null>(null);
  const holders = agents.filter(
    (a) => ns !== null && (a.namespace === ns || a.global),
  );
  const ok = name.trim() !== "" && ns !== null && holder !== null;
  const save = async () => {
    if (!ok) return;
    setError(null);
    try {
      await put.mutateAsync({
        namespace: ns,
        name: name.trim(),
        agentId: holder,
      });
      onClose();
    } catch (e) {
      setError(roleError(e));
    }
  };
  return (
    <Modal
      onClose={onClose}
      title={role ? `Change holder of ${role.name}` : "Add a role"}
      description="A message to a role goes to its holder at send time."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ok || put.isPending} onClick={() => void save()}>
            {role ? "Save" : "Add role"}
          </Button>
        </>
      }
    >
      <div className="grid gap-[var(--oa-space-3)]">
        {!role && (
          <>
            <div className="grid gap-[4px]">
              <Label htmlFor="oa-role-name">Name</Label>
              <Input
                id="oa-role-name"
                value={name}
                autoComplete="off"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-[4px]">
              <span className="text-[length:var(--oa-text-sm)] font-medium">
                Namespace
              </span>
              <OptionSelect
                label="Namespace"
                value={ns}
                placeholder="Pick a namespace"
                options={all.map((n) => ({
                  value: n,
                  label: shortName(n, all),
                }))}
                onChange={(v) => {
                  setNs(v);
                  setHolder(null);
                }}
              />
            </div>
          </>
        )}
        <div className="grid gap-[4px]">
          <span className="text-[length:var(--oa-text-sm)] font-medium">
            Held by
          </span>
          <OptionSelect
            label="Held by"
            value={holder}
            disabled={ns === null}
            placeholder={
              ns === null
                ? "Pick a namespace first"
                : "Pick an agent open there"
            }
            options={holders.map((a) => ({
              value: a.id,
              label: `${a.name} on ${a.machineLabel}`,
            }))}
            onChange={setHolder}
          />
          {ns !== null && holders.length === 0 && (
            <p className={`m-0 ${muted}`}>
              No agent is open in this namespace.
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className={`m-0 ${errorText}`}>
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

export function RolesTab() {
  const roles = useBusRoles();
  const agents = useBusAgents();
  const remove = useDeleteBusRole();
  const stacked = useIsMobile();
  const [editing, setEditing] = useState<BusRole | "new" | null>(null);
  const [removing, setRemoving] = useState<BusRole | null>(null);
  if (roles.isPending) return <p className={`m-0 ${muted}`}>Loading…</p>;
  if (roles.isError)
    return (
      <LoadError
        title="Couldn't load your roles."
        error={roles.error}
        busy={roles.isFetching}
        onRetry={() => void roles.refetch()}
      />
    );
  if (!roles.data.live) return <Notice tone="warning">{LIVE_DOWN}</Notice>;
  const live = agents.data?.live ? agents.data.agents : [];
  const all = [
    ...new Set([
      ...live.map((a) => a.namespace),
      ...roles.data.roles.map((r) => r.namespace),
    ]),
  ];
  const waiting = pending(roles.data.proposals);
  const list = roles.data.roles;
  const actions = (r: BusRole) => (
    <span className="flex justify-end gap-[var(--oa-space-1)]">
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Change holder of ${r.name}`}
        onClick={() => setEditing(r)}
      >
        Change holder
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive"
        aria-label={`Remove ${r.name}`}
        onClick={() => setRemoving(r)}
      >
        Remove
      </Button>
    </span>
  );
  return (
    <div className={STACK}>
      {waiting.length > 0 && (
        <SettingsCard
          id="oa-proposals-h"
          title="Waiting for you"
          subtitle="An AI agent proposed a change. Nothing changes unless you confirm it."
        >
          <ul className="m-0 grid list-none gap-[var(--oa-space-2)] p-0">
            {waiting.map((p) => (
              <li
                key={p.id}
                className="grid gap-[2px] rounded-lg border bg-secondary/40 p-[var(--oa-space-3)] text-[length:var(--oa-text-sm)]"
              >
                <span>
                  <ProposalSentence p={p} all={all} />
                </span>
                <span className={muted}>
                  Proposed {relativeTime(p.createdAt)} · link expires{" "}
                  {relativeTime(p.expiresAt)}. Open the link the agent gave you
                  to confirm it.
                </span>
              </li>
            ))}
          </ul>
        </SettingsCard>
      )}
      <SettingsCard
        id="oa-roles-h"
        title="Roles"
        subtitle="A message to a role goes to its holder at send time."
        action={
          <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
            Add a role
          </Button>
        }
      >
        {list.length === 0 ? (
          <p className={`m-0 ${muted}`}>
            No roles yet. A role is a stable name, like reviewer, that points at
            whichever agent holds it.
          </p>
        ) : stacked ? (
          <ul aria-label="Roles" className="m-0 list-none p-0">
            {list.map((r) => (
              <li
                key={r.id}
                className="grid gap-[2px] border-b py-[var(--oa-space-3)] text-[length:var(--oa-text-sm)] last:border-b-0"
              >
                <span>
                  <RoleRowSentence r={r} all={all} />
                </span>
                <span className={muted}>Set {shortDate(r.setAt)}</span>
                {actions(r)}
              </li>
            ))}
          </ul>
        ) : (
          <Table aria-label="Roles">
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Held by</TableHead>
                <TableHead>Namespace</TableHead>
                <TableHead>Set</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>
                    {r.vacant || r.holderName === null ? (
                      <span className="text-muted-foreground">Vacant</span>
                    ) : (
                      r.holderName
                    )}
                  </TableCell>
                  <TableCell
                    className="text-muted-foreground"
                    title={r.namespace}
                  >
                    {shortName(r.namespace, all)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {shortDate(r.setAt)}
                  </TableCell>
                  <TableCell>{actions(r)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SettingsCard>
      {editing && (
        <RoleDialog
          role={editing === "new" ? null : editing}
          agents={live}
          onClose={() => setEditing(null)}
        />
      )}
      {removing && (
        <ConfirmDialog
          open
          onClose={() => setRemoving(null)}
          title={`Remove ${removing.name}?`}
          body={<p>Messages to {removing.name} are refused from now on.</p>}
          confirm="Remove"
          danger
          onConfirm={() => {
            remove.mutate(removing.id);
            setRemoving(null);
          }}
        />
      )}
    </div>
  );
}

function RoleRowSentence({ r, all }: { r: BusRole; all: string[] }) {
  return (
    <>
      <b>{r.name}</b> in {shortName(r.namespace, all)}:{" "}
      {r.vacant || r.holderName === null ? "vacant" : <b>{r.holderName}</b>}
    </>
  );
}
