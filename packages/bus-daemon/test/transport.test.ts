import { createServer } from "node:http";
import { connect as tcpConnect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubConnection } from "../src/hub.ts";
import {
  closeAll,
  deliver,
  opts,
  PROBE,
  probeWs,
  servers,
  wsServer,
} from "./helpers.ts";

afterEach(closeAll);

describe("hub transport hardening", () => {
  it("a revoked token refused with HTTP 401 at upgrade stops reconnecting and reports revoked", async () => {
    let hits = 0;
    const srv = createServer((_q, s) => s.end());
    srv.on("upgrade", (_req, sock) => {
      sock.on("error", () => {}); // the client may reset a socket we are still closing
      hits++;
      sock.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    });
    let tcp = 0;
    srv.on("connection", () => tcp++);
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    const url = `ws://127.0.0.1:${port}/hub`;
    let revoked!: () => void;
    const gotRevoked = new Promise<void>((r) => {
      revoked = r;
    });
    const onRevoked = vi.fn(revoked);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const hub = new HubConnection(opts(url, { onRevoked }));
      hub.start();
      await gotRevoked;
      // Absence: a stray reconnect timer would fire in this minute, and its
      // connect would be accepted before a probe made after it.
      await vi.advanceTimersByTimeAsync(60_000);
      await new Promise<void>((r) => {
        const probe = tcpConnect(port, "127.0.0.1", () => {
          probe.destroy();
          r();
        });
      });
      expect(hub.reconnecting).toBe(false);
      hub.stop();
      expect(tcp).toBe(2); // the one upgrade, and the probe
      expect(hits).toBe(1);
      expect(onRevoked).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("start() twice keeps one socket and delivers each frame once", async () => {
    const { wss, url } = await wsServer();
    let conns = 0;
    wss.on("connection", (ws, req) => {
      if (req.url === PROBE) return;
      conns++;
      ws.on("message", (d) => {
        if (JSON.parse(String(d)).type === "sessions")
          ws.send(deliver("mmmmmmmmmmmmmmm1"));
      });
    });
    const onFrame = vi.fn();
    const hub = new HubConnection(opts(url, { onFrame }));
    hub.start();
    hub.start();
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalled());
    // Absence: a duplicate socket was begun with the first and is accepted
    // before a probe made now.
    await probeWs(url);
    hub.stop();
    expect(conns).toBe(1);
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it("start() during the backoff timer does not open a second socket", async () => {
    const { wss, url } = await wsServer();
    let conns = 0;
    let first = true;
    let second!: () => void;
    const secondConn = new Promise<void>((r) => {
      second = r;
    });
    wss.on("connection", (ws, req) => {
      if (req.url === PROBE) return;
      conns++;
      if (first) {
        first = false;
        ws.close(1011);
      } else second();
    });
    let closed!: () => void;
    const gotClose = new Promise<void>((r) => {
      closed = r;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const hub = new HubConnection(
        opts(url, { backoffMs: () => 150, onClose: closed }),
      );
      hub.start();
      await gotClose;
      await Promise.resolve(); // the close handler ran on: the backoff is set
      expect(hub.reconnecting).toBe(true);
      hub.start();
      await vi.advanceTimersByTimeAsync(150);
      await secondConn;
      // Absence: a second reconnect would have fired in this minute, and been
      // accepted before a probe made after it.
      await vi.advanceTimersByTimeAsync(60_000);
      await probeWs(url);
      hub.stop();
      expect(conns).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a throwing sessions() provider does not crash the process", async () => {
    const { wss, url } = await wsServer();
    let connected = false;
    wss.on("connection", () => {
      connected = true;
    });
    let opened!: () => void;
    const gotOpen = new Promise<void>((r) => {
      opened = r;
    });
    const errors: unknown[] = [];
    const h = (e: unknown) => errors.push(e);
    const listeners = process.listeners("uncaughtException");
    process.removeAllListeners("uncaughtException");
    process.on("uncaughtException", h);
    try {
      const hub = new HubConnection(
        opts(url, {
          sessions: () => {
            throw new Error("boom");
          },
          onOpen: opened,
        }),
      );
      hub.start();
      await gotOpen; // after the throwing sessions() call
      // An uncaught exception surfaces within a turn of the event loop.
      await new Promise<void>((r) => setImmediate(r));
      expect(connected).toBe(true);
      hub.stop();
    } finally {
      process.removeListener("uncaughtException", h);
      for (const l of listeners) process.on("uncaughtException", l);
    }
    expect(errors).toEqual([]);
  });

  it("send() while disconnected tells the caller the frame was not sent", async () => {
    const hub = new HubConnection(opts("ws://127.0.0.1:1/hub"));
    const r = hub.send({
      v: 1,
      id: "s1",
      type: "ack",
      msg_id: "mmmmmmmmmmmmmmm1",
    }) as unknown;
    expect(r).toBe(false);
  });

  it("a hub that accepts then immediately drops does not reset backoff (no tight loop)", async () => {
    const { wss, url } = await wsServer();
    let conns = 0;
    wss.on("connection", (ws) => {
      conns++;
      ws.close(1011);
    });
    const delays: number[] = [];
    const hub = new HubConnection(
      opts(url, {
        backoffMs: (a) => {
          delays.push(a);
          return 20;
        },
      }),
    );
    hub.start();
    await vi.waitFor(() => expect(conns).toBeGreaterThanOrEqual(4));
    hub.stop();
    expect(Math.max(...delays)).toBeGreaterThan(0);
  });

  it("does not leak the token through the log sink on any path", async () => {
    const { wss, url } = await wsServer();
    wss.on("connection", (ws) => ws.send("not json"));
    const logs: string[] = [];
    const hub = new HubConnection(
      opts(url, {
        log: (m) => logs.push(m),
        onFrame: () => {
          throw new Error("x");
        },
      }),
    );
    hub.start();
    await vi.waitFor(() => expect(logs.length).toBeGreaterThan(0));
    hub.stop();
    expect(logs.join("\n")).not.toContain("SECRET");
  });

  it("keeps backing off on a 500 at upgrade", async () => {
    let hits = 0;
    const srv = createServer((_q, s) => s.end());
    srv.on("upgrade", (_req, sock) => {
      sock.on("error", () => {}); // the client may reset a socket we are still closing
      hits++;
      sock.end("HTTP/1.1 500 Oops\r\nContent-Length: 0\r\n\r\n");
    });
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const url = `ws://127.0.0.1:${(srv.address() as { port: number }).port}/hub`;
    const onRevoked = vi.fn();
    const hub = new HubConnection(opts(url, { onRevoked }));
    hub.start();
    await vi.waitFor(() => expect(hits).toBeGreaterThanOrEqual(3));
    hub.stop();
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it("isolates throwing onOpen and onRevoked", async () => {
    const { wss, url } = await wsServer();
    wss.on("connection", (ws) => ws.close(4403));
    const log = vi.fn();
    const hub = new HubConnection(
      opts(url, {
        log,
        onOpen: () => {
          throw new Error("o");
        },
        onRevoked: () => {
          throw new Error("r");
        },
      }),
    );
    hub.start();
    await vi.waitFor(() =>
      expect(log.mock.calls.join()).toContain("onRevoked"),
    );
    hub.stop();
    expect(log.mock.calls.join()).toContain("onOpen");
  });

  it("stop() while connecting closes the pending socket", async () => {
    const { wss, url } = await wsServer();
    let conns = 0;
    wss.on("connection", (_ws, req) => {
      if (req.url !== PROBE) conns++;
    });
    const hub = new HubConnection(opts(url));
    hub.start();
    hub.stop();
    // Absence: a connect begun before the stop is accepted before a probe made now.
    await probeWs(url);
    expect(hub.open).toBe(false);
    expect(conns).toBe(0);
  });

  it("send() on an open socket returns true", async () => {
    const { url } = await wsServer();
    const hub = new HubConnection(opts(url));
    hub.start();
    await vi.waitFor(() => expect(hub.open).toBe(true));
    expect(
      hub.send({ v: 1, id: "s1", type: "ack", msg_id: "mmmmmmmmmmmmmmm1" }),
    ).toBe(true);
    hub.stop();
  });
});
