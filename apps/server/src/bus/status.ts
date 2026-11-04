/**
 * Self-reported agent status (agent card, AC3), on the agent row: `status`,
 * `status_label` and `status_at` are the applied update; `status_next` (JSON
 * AgentStatus) and `status_due` a coalesced one. The first update in a
 * STATUS_WINDOW_MS window applies at once; later ones only replace
 * `status_next`, which the alarm applies at `status_due` (applyDueStatus).
 * Both live in SQLite, so a pending update survives an eviction. Every close
 * clears all five (STATUS_CLEAR in the close statements, clearStatus on a
 * reopen).
 */
import {
  type AgentStatus,
  AgentStatusSchema,
  BAD_NS_CHARS,
  LIMITS,
  STATUS_WINDOW_MS,
  StatusLabelSchema,
  StatusStateSchema,
} from "@oa/bus-protocol";
import { iso } from "./dto.js";

/** SET clause clearing applied and pending status (no values). */
export const STATUS_CLEAR =
  "status = null, status_label = null, status_at = null, status_next = null, status_due = null";

const BAD_LABEL_CHARS = new RegExp(BAD_NS_CHARS.source, "gu");

/**
 * Cleaned as newMachineLabel cleans a label (NFC, no control, bidi or
 * zero-width characters, trimmed), capped at maxLabelChars code points.
 * Null when nothing is left.
 */
export function cleanStatusLabel(label: string | undefined): string | null {
  if (label === undefined) return null;
  const clean = label
    .normalize("NFC")
    .replace(BAD_LABEL_CHARS, "")
    .normalize("NFC");
  const out = [...clean].slice(0, LIMITS.maxLabelChars).join("").trim();
  return out !== "" && StatusLabelSchema.safeParse(out).success ? out : null;
}

function set(
  sql: SqlStorage,
  agentId: string,
  s: AgentStatus,
  now: number,
): void {
  sql.exec(
    "update agents set status = ?, status_label = ?, status_at = ?, status_next = null, status_due = null where id = ?",
    s.state,
    s.label ?? null,
    now,
    agentId,
  );
}

/**
 * Applies `s` to open agent `agentId` now if its last applied update is a
 * window old (or none), else stores it as the pending one, due when that
 * window closes (the caller arms the alarm for `due`). An update equal to
 * the applied one (state and cleaned label) is no change: nothing is
 * written but a pending update is dropped (this one supersedes it), and
 * `status_at` keeps when the shown status was first applied.
 */
export function applyStatus(
  sql: SqlStorage,
  agentId: string,
  s: { state: AgentStatus["state"]; label?: string },
  now: number,
): { applied: boolean; due: number | null } {
  const label = cleanStatusLabel(s.label);
  const next: AgentStatus =
    label === null ? { state: s.state } : { state: s.state, label };
  const row = sql
    .exec<{ at: number | null; state: string | null; label: string | null }>(
      "select status_at as at, status as state, status_label as label from agents where id = ? and live = 1",
      agentId,
    )
    .toArray()[0];
  if (row === undefined) return { applied: false, due: null };
  if (row.state === next.state && row.label === label) {
    sql.exec(
      "update agents set status_next = null, status_due = null where id = ? and status_due is not null",
      agentId,
    );
    return { applied: false, due: null };
  }
  if (row.at === null || now >= row.at + STATUS_WINDOW_MS) {
    set(sql, agentId, next, now);
    return { applied: true, due: null };
  }
  const due = row.at + STATUS_WINDOW_MS;
  sql.exec(
    "update agents set status_next = ?, status_due = ? where id = ?",
    JSON.stringify(next),
    due,
    agentId,
  );
  return { applied: false, due };
}

export type StatusChange = { id: string; namespace: string; global: number };

/**
 * Applies up to `limit` pending updates due by `now`, oldest first; returns
 * the agents that changed. A pending update on a closed agent, or one that
 * no longer parses, is dropped, never applied.
 */
export function applyDueStatus(
  sql: SqlStorage,
  now: number,
  limit: number,
): StatusChange[] {
  if (limit <= 0) return [];
  const rows = sql
    .exec<StatusChange & { live: number; next: string | null }>(
      `select id, namespace, global, live, status_next as next from agents
        indexed by agents_status_due where status_due <= ? order by status_due limit ?`,
      now,
      limit,
    )
    .toArray();
  const changed: StatusChange[] = [];
  for (const r of rows) {
    let next: AgentStatus | null = null;
    try {
      const p = AgentStatusSchema.safeParse(JSON.parse(r.next ?? "null"));
      if (p.success) next = p.data;
    } catch {
      // Unparseable: dropped below.
    }
    if (r.live === 1 && next !== null) {
      set(sql, r.id, next, now);
      changed.push({ id: r.id, namespace: r.namespace, global: r.global });
    } else
      sql.exec(
        "update agents set status_next = null, status_due = null where id = ?",
        r.id,
      );
  }
  return changed;
}

/** Clears applied and pending status of `agentIds`. */
export function clearStatus(sql: SqlStorage, agentIds: string[]): void {
  if (agentIds.length === 0) return;
  sql.exec(
    `update agents set ${STATUS_CLEAR} where id in (select value from json_each(?))`,
    JSON.stringify(agentIds),
  );
}

/** The earliest pending update's due time, or null. */
export const nextStatusDue = (sql: SqlStorage): number | null =>
  sql
    .exec<{ t: number | null }>(
      "select min(status_due) as t from agents indexed by agents_status_due where status_due is not null",
    )
    .one().t;

/** Stored status columns, as AGENT_COLS reads them. */
export type StatusCols = {
  status?: string | null;
  statusLabel?: string | null;
  statusAt?: number | null;
};

/**
 * A row's applied status as REST fields, or {} when it has none or a stored
 * value no longer validates (the agent is still listed).
 */
export function statusFields(r: StatusCols): {
  status?: AgentStatus["state"];
  statusLabel?: string;
  statusAt?: string;
} {
  const state = StatusStateSchema.safeParse(r.status);
  if (!state.success || typeof r.statusAt !== "number") return {};
  const label =
    typeof r.statusLabel === "string" &&
    StatusLabelSchema.safeParse(r.statusLabel).success
      ? r.statusLabel
      : undefined;
  return {
    status: state.data,
    ...(label === undefined ? {} : { statusLabel: label }),
    statusAt: iso(r.statusAt),
  };
}

/** The same, as roster row (wire) fields. */
export function statusWire(r: StatusCols): {
  status?: AgentStatus["state"];
  status_label?: string;
  status_at?: string;
} {
  const f = statusFields(r);
  if (f.status === undefined || f.statusAt === undefined) return {};
  return {
    status: f.status,
    ...(f.statusLabel === undefined ? {} : { status_label: f.statusLabel }),
    status_at: f.statusAt,
  };
}
