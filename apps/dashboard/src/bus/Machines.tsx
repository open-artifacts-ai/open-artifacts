// #1293 placeholder: the data layer as a plain list. Design's layout replaces it.
import type { BusMachine } from "@oa/shared";
import { Button } from "@oa/ui/shadcn";
import { useState } from "react";
import { useBusMachines, useRevokeBusMachine } from "../api/queries";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { ConfirmDialog } from "../settings/ConfirmDialog";

/** Live, Offline, Unknown (the bus couldn't be asked) or Revoked. */
export const machineStatus = (m: BusMachine) =>
  m.revokedAt !== null
    ? "Revoked"
    : m.connected === null
      ? "Unknown"
      : m.connected
        ? "Live"
        : "Offline";

export function Machines() {
  useDocumentTitle("Machines");
  const q = useBusMachines();
  const revoke = useRevokeBusMachine();
  const [pick, setPick] = useState<BusMachine | null>(null);
  return (
    <section>
      <h2>Machines</h2>
      {q.isPending ? (
        <p>Loading…</p>
      ) : q.isError ? (
        <p>
          Couldn't load your machines.{" "}
          <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
            Retry
          </Button>
        </p>
      ) : q.data.machines.length === 0 ? (
        <p>No machines yet</p>
      ) : (
        <ul aria-label="Your machines">
          {q.data.machines.map((m) => (
            <li key={m.id}>
              {m.label} · {machineStatus(m)} · Last used{" "}
              {m.lastUsedAt ?? "Never"}
              {m.revokedAt === null && (
                <>
                  {" "}
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Revoke ${m.label}`}
                    onClick={() => setPick(m)}
                  >
                    Revoke
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {pick && (
        <ConfirmDialog
          open
          onClose={() => setPick(null)}
          title={`Revoke "${pick.label}"?`}
          body={
            <p>
              Its connection closes at once and its agents leave the list.
              Messages to them are refused. This can't be undone.
            </p>
          }
          confirm="Revoke"
          danger
          onConfirm={() => {
            revoke.mutate(pick.id);
            setPick(null);
          }}
        />
      )}
    </section>
  );
}
