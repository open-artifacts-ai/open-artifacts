import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubConnection } from "../src/hub.ts";
import { closeAll, opts, servers, wsServer } from "./helpers.ts";

afterEach(async () => {
  vi.useRealTimers();
  await closeAll();
});

describe("keepalive", () => {
  it("sends the bare ping string and tolerates pong without logging it", async () => {
    const { wss, url } = await wsServer();
    const pings: string[] = [];
    wss.on("connection", (ws) => {
      ws.on("message", (d) => {
        if (String(d) === "ping") {
          pings.push("ping");
          ws.send("pong");
        }
      });
    });
    const log = vi.fn();
    const onFrame = vi.fn();
    // Only the clock is faked, so a stalled event loop can never look like a silent link.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const hub = new HubConnection(opts(url, { pingMs: 100, log, onFrame }));
    hub.start();
    await vi.waitFor(() => expect(hub.open).toBe(true));
    for (let n = 1; n <= 3; n++) {
      vi.advanceTimersByTime(100);
      await vi.waitFor(() => expect(pings.length).toBeGreaterThanOrEqual(n));
      // The pong is read at the same fake instant, keeping the link fresh.
      await vi.waitFor(() => expect(hub.open).toBe(true));
    }
    expect(log).not.toHaveBeenCalled();
    expect(onFrame).not.toHaveBeenCalled();
    hub.stop();
  });

  it("reconnects when nothing arrives within two intervals", async () => {
    const { wss, url } = await wsServer();
    let conns = 0;
    wss.on("connection", () => conns++); // never answers
    const hub = new HubConnection(opts(url, { pingMs: 40 }));
    hub.start();
    await vi.waitFor(() => expect(conns).toBeGreaterThanOrEqual(2));
    hub.stop();
  });

  it("retries a hub that never answers the upgrade", async () => {
    const socks: Socket[] = [];
    const srv = createServer((s) => {
      s.on("error", () => {});
      socks.push(s);
    });
    servers.push({
      close: (cb) => {
        for (const s of socks) s.destroy();
        srv.close(() => cb());
      },
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const url = `ws://127.0.0.1:${(srv.address() as { port: number }).port}/hub`;
    const hub = new HubConnection(opts(url, { handshakeTimeoutMs: 80 }));
    hub.start();
    await vi.waitFor(() => expect(socks.length).toBeGreaterThanOrEqual(2));
    hub.stop();
  });
});
