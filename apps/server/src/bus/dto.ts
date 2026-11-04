import { type BusAgent, BusAgentSchema } from "@oa/shared";
import { logWarn } from "../log.js";
import type { AgentRow } from "./rows.js";
import { statusFields } from "./status.js";

/**
 * Epoch ms to ISO 8601 (UTC, `Z`); null stays null. Never throws: an
 * out-of-range or non-finite value gives "", which fails the schema, so that
 * row is skipped (validAgents) instead of breaking the whole list.
 */
export function iso(ms: number): string;
export function iso(ms: number | null): string | null;
export function iso(ms: number | null): string | null {
  if (ms === null) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/** An open agent row joined with its (unrevoked) machine's label. */
export type AgentWithMachine = Omit<AgentRow, "sessionStartRowid"> & {
  machineLabel: string;
};

/**
 * An open agent as the dashboard's GET /api/v1/bus/agents lists it
 * (BusAgentSchema). `connected`: its machine holds a daemon socket (live),
 * else queued. Callers omit closed agents and agents of revoked machines.
 */
export const agentDto = (a: AgentWithMachine, connected: boolean): BusAgent => ({
  id: a.id,
  namespace: a.namespace,
  name: a.name,
  kind: a.kind,
  machineId: a.machineId,
  machineLabel: a.machineLabel,
  global: a.global === 1,
  state: connected ? "live" : "queued",
  updatedAt: iso(a.updatedAt),
  ...statusFields(a),
});

/** The DTOs that parse with BusAgentSchema; the rest are skipped (one log line, no contents). */
export function validAgents(dtos: BusAgent[]): BusAgent[] {
  const ok = dtos.filter((d) => BusAgentSchema.safeParse(d).success);
  if (ok.length < dtos.length)
    logWarn("bus_invalid_agent_rows", undefined, {
      count: dtos.length - ok.length,
    });
  return ok;
}
