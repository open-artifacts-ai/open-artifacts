import type { Kind } from "@oa/bus-ipc";

export type AgentRecord = {
  ref: string;
  kind: Kind;
  proposedName: string;
  busName: string;
  namespace: string;
  global: boolean;
  pid: number;
  cwd: string;
  live: boolean;
  /** A Claude session's process start, from its session file; tells a reused pid. */
  procStart?: string;
  /**
   * #1295: the agent_ref this session took over from after a /clear (the same
   * live process reported a new session). Sent on `agent_up` to a hub that
   * lists `mailbox`, until the hub answers.
   */
  replaces?: string;
};

export class AgentTable {
  #byRef = new Map<string, AgentRecord>();
  up(rec: AgentRecord): AgentRecord {
    this.#byRef.set(rec.ref, rec);
    return rec;
  }
  down(ref: string): void {
    this.#byRef.delete(ref);
  }
  byRef(ref: string): AgentRecord | undefined {
    return this.#byRef.get(ref);
  }
  byName(name: string): AgentRecord | undefined {
    for (const a of this.#byRef.values()) if (a.busName === name) return a;
    return undefined;
  }
  all(): AgentRecord[] {
    return [...this.#byRef.values()];
  }
  openRefs(): string[] {
    return this.all()
      .filter((a) => a.live)
      .map((a) => a.ref);
  }
  closedRefs(): string[] {
    return this.all()
      .filter((a) => !a.live)
      .map((a) => a.ref);
  }
}
