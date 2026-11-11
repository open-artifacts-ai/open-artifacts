import type { Kind } from "@oa/bus-ipc";

export type AgentRecord = {
  ref: string;
  kind: Kind;
  proposedName: string;
  busName: string;
  namespace: string;
  /** Where the namespace came from (#1570): shown by status, doctor and self. */
  namespaceSource?: "config" | "git" | "dir" | "cwd";
  global: boolean;
  pid: number;
  cwd: string;
  live: boolean;
  /** A Claude session's process start, from its session file; tells a reused pid. */
  procStart?: string;
  /**
   * #1635: the name the session file last gave (a Claude `/rename` rewrites
   * it). A change from this is a rename for the hub; the hub's own answer
   * (a `-2`, a refusal) never is one. Unset: compare with `proposedName`.
   */
  sessionName?: string;
  /** The name the hub was last told for this agent (agent_up or rename). */
  sentName?: string;
  /**
   * #1295: the agent_ref this session took over from after a /clear (the same
   * live process reported a new session). Sent on `agent_up` to a hub that
   * lists `mailbox`, until the hub answers.
   */
  replaces?: string;
  /**
   * #1822: the hashes of the proofs this session's `oa-bus mcp-proof` helper
   * sent, oldest first, at most LINK_HASHES_MAX (#1984: a later run must not
   * unlink the header an earlier one gave Claude). A live Claude
   * record's hashes are also kept in claude-links.json (#2050), keyed by pid +
   * procStart, so a restarted daemon replays them: Claude never re-runs its
   * helper.
   */
  linkHashes?: string[];
};

/** #1984: most proof hashes a session keeps; the hub holds the same number. */
export const LINK_HASHES_MAX = 4;

/** `list` with `hash` newest, a repeat moved to the end, at most LINK_HASHES_MAX. */
export const withLinkHash = (
  list: readonly string[] | undefined,
  hash: string,
): string[] =>
  [...(list ?? []).filter((h) => h !== hash), hash].slice(-LINK_HASHES_MAX);

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
