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
