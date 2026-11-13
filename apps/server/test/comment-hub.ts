import { env } from "cloudflare:workers";
import { newId } from "@oa/shared";
import type { Env } from "../src/env.js";

// #2224: a stub BUS_HUB for comment tests. Each member's hub answers from one
// table of agents (identity id -> current address), so a test can rename an
// agent, hand its name to another, or make the hub slow or failing.

export type HubAgent = {
  identityId: string;
  namespace: string;
  name: string;
  /** The member whose hub lists it. */
  owner: string;
};

export class FakeHubs {
  agents = new Map<string, HubAgent>();
  mode: "ok" | "hang" | "fail" = "ok";
  /** Registers (or moves) an agent and returns it. */
  set(a: HubAgent): HubAgent {
    this.agents.set(a.identityId, a);
    return a;
  }
  /** A fresh env whose BUS_HUB is this table. */
  env(): Env {
    const guard = async <T>(v: T): Promise<T> => {
      if (this.mode === "fail") throw new Error("hub down");
      if (this.mode === "hang") return new Promise<never>(() => {});
      return v;
    };
    const hubOf = (hubName: string) => {
      const mine = () =>
        [...this.agents.values()].filter((a) => `bus:${a.owner}` === hubName);
      return {
        snapshot: async () => ({
          connected: [],
          agents: mine().map((a) => ({
            id: a.identityId,
            namespace: a.namespace,
            name: a.name,
            kind: "claude",
            machineId: "m",
            machineLabel: "m",
            global: false,
            state: "live",
            running: true,
            since: null,
            updatedAt: new Date().toISOString(),
          })),
        }),
        namesOf: (ids: string[]) =>
          guard(
            mine()
              .filter((a) => ids.includes(a.identityId))
              .map((a) => ({ identityId: a.identityId, name: a.name })),
          ),
        identityOf: (namespace: string, name: string) => {
          const a = mine().find(
            (x) => x.namespace === namespace && x.name === name,
          );
          return guard(a ? { identityId: a.identityId, kind: "x" } : null);
        },
      };
    };
    return {
      ...env,
      BUS_HUB: { idFromName: (n: string) => n, get: hubOf },
    } as unknown as Env;
  }
}

/** A connected machine row, so the member counts as having a hub. */
export async function connectedMachine(
  db: Env["DB"],
  userId: string,
): Promise<string> {
  const id = newId();
  await db
    .prepare(
      "insert into bus_machines (id, user_id, label, token_hash, created_at, last_used_at) values (?, ?, 'm', ?, ?, ?)",
    )
    .bind(id, userId, newId(), Date.now(), Date.now())
    .run();
  return id;
}
