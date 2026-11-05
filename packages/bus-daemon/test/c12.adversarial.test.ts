import type { ClientFrame } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { HubConnection } from "../src/hub.ts";
import { Outbox } from "../src/outbox.ts";
import { FramePacer } from "../src/pacer.ts";

const f = (type: string, n = 0) =>
  ({ v: 1, id: `${type}-${n}`, type }) as unknown as ClientFrame;

describe("C12 adversarial", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a sessions snapshot does not overtake a send queued before it", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const p = new FramePacer({ send: (d) => out.push(d) > 0 });
    for (let i = 0; i < 10; i++) p.push(f("send", i), `send-${i}`);
    p.push(f("sessions"), "sessions");
    vi.advanceTimersByTime(5_000);
    // A native reply then its session closing: the hub must see the send first.
    expect(out.indexOf("sessions")).toBeGreaterThan(out.indexOf("send-9"));
  });

  it("a user send is not starved past the 10 s pending timeout by a reconnect ack/agent_up backlog", () => {
    vi.useFakeTimers();
    const out: { d: string; at: number }[] = [];
    const t0 = Date.now();
    const p = new FramePacer({
      send: (d) => out.push({ d, at: Date.now() }) > 0,
    });
    for (let i = 0; i < 200; i++) p.push(f("agent_up", i), `up-${i}`);
    for (let i = 0; i < 200; i++) p.push(f("ack", i), `ack-${i}`);
    p.push(f("send"), "user-send");
    vi.advanceTimersByTime(30_000);
    const at = out.find((o) => o.d === "user-send")?.at ?? Infinity;
    expect(at - t0).toBeLessThan(10_000);
  });

  it("an Outbox reply queued in the pacer survives a link drop", async () => {
    // Which frames are on the wire is fixed by the token bucket, not by timing:
    // with the clock frozen, hello + sessions + 2 replies spend the burst of 4,
    // so replies 2..19 are queued in the pacer when the first link drops.
    vi.useFakeTimers({ toFake: ["Date"] });
    const first: string[] = [];
    const second: string[] = [];
    let conns = 0;
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    wss.on("connection", (ws) => {
      conns++;
      const link = conns === 1 ? first : second;
      ws.on("message", (d) => {
        const fr = JSON.parse(String(d));
        if (fr.type !== "send") return;
        link.push(fr.id);
        // The drop is driven by what the pacer wrote: both written replies are in.
        if (link === first && first.length === 2) {
          vi.useRealTimers();
          ws.terminate();
        }
      });
    });
    const port = (wss.address() as { port: number }).port;
    let outbox!: Outbox<ClientFrame>;
    let opened!: () => void;
    const ready = new Promise<void>((r) => {
      opened = r;
    });
    const hub = new HubConnection({
      url: `ws://127.0.0.1:${port}/hub`,
      token: "oa_machine_x",
      label: "l",
      version: "0",
      sessions: () => ({ open: [], closed: [] }),
      onFrame: () => {},
      onRevoked: () => {},
      onOpen: () => {
        outbox?.flush();
        opened();
      },
      backoffMs: () => 10,
      pace: { burst: 4 },
    });
    outbox = new Outbox<ClientFrame>({
      send: (fr, unsent) => hub.send(fr, unsent),
    });
    hub.start();
    await ready;
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      ids.push(id);
      outbox.push({
        v: 1,
        id,
        type: "send",
        from_ref: "a1",
        to_name: "peer",
        body: `reply ${i}`,
      } as ClientFrame);
    }
    try {
      await vi.waitFor(() => expect(second.length).toBe(18), {
        timeout: 4000,
      });
      // Written before the drop: delivered on the first link, never resent.
      expect(first).toEqual(ids.slice(0, 2));
      // Still queued in the pacer at the drop: resent on the next link, in order.
      expect(second).toEqual(ids.slice(2));
    } finally {
      vi.useRealTimers();
      hub.stop();
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });
});

describe("C12 adversarial, round 1", () => {
  it("the user share never puts an agent's send ahead of its own queued agent_up", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const p = new FramePacer({ send: (d) => out.push(d) > 0 });
    // Reconnect replay: agent_up for 50 agents, then the outbox flush.
    for (let i = 0; i < 50; i++)
      p.push(
        { v: 1, id: `up-${i}`, type: "agent_up" } as unknown as ClientFrame,
        `up-${i}`,
      );
    p.push(
      {
        v: 1,
        id: "s",
        type: "send",
        from_ref: "r49",
      } as unknown as ClientFrame,
      "send-from-49",
    );
    vi.advanceTimersByTime(10_000);
    // The hub answers a send from an unregistered ref not_registered: the reply is lost.
    expect(out.indexOf("send-from-49")).toBeGreaterThan(out.indexOf("up-49"));
  });

  it("an outbox frame handed back on overflow is retried while the link stays up", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const p = new FramePacer({
      send: (d) => out.push(d) > 0,
      max: 10,
      burst: 1,
    });
    const ob = new Outbox<ClientFrame>({
      send: (f, unsent) => p.push(f, f.id, unsent),
    });
    for (let i = 0; i < 12; i++)
      ob.push({ v: 1, id: `r${i}`, type: "send" } as unknown as ClientFrame);
    vi.advanceTimersByTime(60_000);
    // No reconnect, so no flush: whatever came back must still go out.
    expect(new Set(out)).toEqual(
      new Set(Array.from({ length: 12 }, (_, i) => `r${i}`)),
    );
  });
});

describe("C12 adversarial, round 2", () => {
  const fr = (o: object) => ({ v: 1, ...o }) as unknown as ClientFrame;

  it("with acks starving the user lane, a send still waits for its own agent_up", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const p = new FramePacer({ send: (d) => out.push(d) > 0 });
    for (let i = 0; i < 50; i++)
      p.push(
        fr({ id: `up-${i}`, type: "agent_up", agent_ref: `r${i}` }),
        `up-${i}`,
      );
    p.push(fr({ id: "s49", type: "send", from_ref: "r49" }), "send-49");
    p.push(fr({ id: "s0", type: "send", from_ref: "rX" }), "send-other");
    for (let i = 0; i < 100; i++)
      p.push(fr({ id: `a${i}`, type: "ack" }), `ack-${i}`);
    vi.advanceTimersByTime(20_000);
    expect(out.indexOf("send-49")).toBeGreaterThan(out.indexOf("up-49"));
    // An unrelated agent's send is not held behind the backlog.
    expect(out.indexOf("send-other")).toBeLessThan(10);
  });
});
