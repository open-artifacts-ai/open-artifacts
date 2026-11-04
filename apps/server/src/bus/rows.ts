// Row shapes of the BusHub's SQLite tables (bus/schema.ts), ported from
// OpenBus 0.63.0 (apps/server/src/hub/rows.ts).

/**
 * The hub's mirror of a D1 bus_machines row it has accepted a socket for.
 * Never carries the token or its hash (those live in D1 only).
 */
export type MachineRow = {
  id: string;
  label: string;
  createdAt: number;
  revokedAt: number | null;
  /** True while the hub holds a socket tagged with this id; always false once revoked. */
  connected: boolean;
};

export type AgentRow = {
  id: string;
  namespace: string;
  name: string;
  lastName: string | null;
  kind: string;
  machineId: string;
  nativeRef: string;
  global: number;
  live: number;
  updatedAt: number;
  /** max(receipts.rowid) when the current session began (B11 L1); 0 for older rows. */
  sessionStartRowid: number;
  /** AC3 applied status (bus/status.ts); null when none. */
  status?: string | null;
  statusLabel?: string | null;
  statusAt?: number | null;
};

/** Fixed column lists (no values): every value in a query stays a bound parameter. */
export const MACHINE_COLS =
  "id, label, created_at as createdAt, revoked_at as revokedAt";
export const AGENT_COLS =
  "id, namespace, name, last_name as lastName, kind, machine_id as machineId, native_ref as nativeRef, global, live, updated_at as updatedAt, session_start_rowid as sessionStartRowid, status, status_label as statusLabel, status_at as statusAt";
