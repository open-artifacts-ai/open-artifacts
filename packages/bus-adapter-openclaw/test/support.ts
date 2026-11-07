import type { DaemonClient } from "@oa/bus-ipc";
import { Bus, type BusDeps } from "../src/bus.ts";
import type { Root } from "../src/roots.ts";

export type Msg = { id: string; from?: string; body?: string };

/** A stand-in for the daemon and hub: it keeps what is unacked and pushes it on every connect. */
export class Hub {
  unacked = new Map<string, Msg>();
  acks: string[] = [];
  connects: string[] = [];
  clients: FakeClient[] = [];
  down = false;
  push(m: Msg): void {
    this.unacked.set(m.id, m);
    for (const c of this.clients) if (c.state === "open") c.deliver(m);
  }
  connect = async (root: Root): Promise<DaemonClient> => {
    this.connects.push(root.ref);
    if (this.down) throw new Error("the daemon is not reachable");
    const c = new FakeClient(this);
    this.clients.push(c);
    return c as unknown as DaemonClient;
  };
}

export class FakeClient {
  state: "open" | "closed" = "open";
  welcome = {
    type: "welcome",
    bus_name: "openclaw-1",
    namespace: "ns",
    global: false,
  };
  private cb?: (f: unknown) => void;
  private ncb?: (t: string) => void;
  constructor(private hub: Hub) {}
  deliver(m: Msg) {
    this.cb?.({
      v: 1,
      id: "d",
      type: "deliver",
      msg_id: m.id,
      from_name: m.from ?? "peer",
      namespace: "ns",
      body: m.body ?? `body of ${m.id}`,
    });
  }
  onDeliver(cb: (f: unknown) => void) {
    this.cb = cb;
    for (const m of this.hub.unacked.values()) this.deliver(m);
  }
  onNotice(cb: (t: string) => void) {
    this.ncb = cb;
  }
  notice(t: string) {
    this.ncb?.(t);
  }
  ack(id: string) {
    this.hub.acks.push(id);
    this.hub.unacked.delete(id);
  }
  async request(f: { type: string }) {
    if (f.type === "self")
      return {
        type: "agent",
        agent: { name: "openclaw-1", namespace: "ns", global: false },
      };
    if (f.type === "list")
      return {
        type: "roster",
        agents: [
          {
            name: "peer",
            namespace: "ns",
            kind: "pi",
            live: true,
            global: false,
          },
        ],
      };
    return { type: "error", code: "bad_frame", message: "no" };
  }
  close() {
    this.state = "closed";
  }
}

export const flush = () => new Promise<void>((r) => setTimeout(r, 5));

export const caller = (over: Record<string, unknown> = {}) => ({
  agentId: "main",
  sessionKey: "agent:main:main",
  trigger: "user",
  runId: "run-1",
  ...over,
});

export function newBus(hub: Hub, over: Partial<BusDeps> = {}) {
  return new Bus({
    connect: hub.connect,
    stateDir: () => "/state/.openclaw",
    settleMs: 0,
    ...over,
  });
}

/** Connects the root (a first turn) and lets the hub's pushes land. */
export async function online(bus: Bus, c = caller({ runId: "warm" })) {
  bus.buildPrompt(c);
  await flush();
  return c;
}
