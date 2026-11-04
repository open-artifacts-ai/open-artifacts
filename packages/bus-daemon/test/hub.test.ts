import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { tokenHash } from "../src/config.ts";
import { HubConnection, type HubOptions } from "../src/hub.ts";
import { runDaemon } from "../src/index.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

const servers: WebSocketServer[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

async function listen(wss: WebSocketServer): Promise<string> {
  servers.push(wss);
  if (!wss.address()) {
    await new Promise<void>((r) => wss.once("listening", () => r()));
  }
  const addr = wss.address() as { port: number };
  return `ws://127.0.0.1:${addr.port}/hub`;
}

const types = (seen: unknown[]) =>
  seen.map((f) => (f as { type: string }).type);

function opts(url: string, over: Partial<HubOptions> = {}): HubOptions {
  return {
    url,
    token: "oa_machine_x",
    label: "laptop",
    version: "0.1.0",
    sessions: () => ({ open: ["a1"], closed: ["b2"] }),
    onFrame: () => {},
    onRevoked: () => {},
    onOpen: () => {},
    backoffMs: () => 10,
    ...over,
  };
}

describe("hub connection", () => {
  it("sends hello, then sessions on every reconnect", async () => {
    const seen: unknown[] = [];
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    wss.on("connection", (ws, req) => {
      expect(req.headers.authorization).toBe("Bearer oa_machine_x");
      ws.on("message", (d) => seen.push(JSON.parse(String(d))));
    });
    const hub = new HubConnection(opts(await listen(wss)));
    hub.start();
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2));
    expect(seen[0]).toMatchObject({
      v: 1,
      type: "hello",
      machine_label: "laptop",
    });
    expect(seen[1]).toMatchObject({
      v: 1,
      type: "sessions",
      open: ["a1"],
      closed: ["b2"],
    });
    wss.clients.forEach((c) => {
      c.close();
    });
    await vi.waitFor(() =>
      expect(types(seen).filter((t) => t === "hello").length).toBe(2),
    );
    await vi.waitFor(() =>
      expect(types(seen).filter((t) => t === "sessions").length).toBe(2),
    );
    hub.stop();
  });

  it("stops and reports revocation on close 4403", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let connections = 0;
    wss.on("connection", (ws) => {
      connections++;
      ws.close(4403, "revoked");
    });
    const onRevoked = vi.fn();
    const hub = new HubConnection(opts(await listen(wss), { onRevoked }));
    hub.start();
    await vi.waitFor(() => expect(onRevoked).toHaveBeenCalled());
    expect(hub.reconnecting).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(connections).toBe(1);
    hub.stop();
  });

  it("does not reconnect when stop() lands during a backoff timer", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let connections = 0;
    wss.on("connection", (ws) => {
      connections++;
      ws.close();
    });
    const hub = new HubConnection(
      opts(await listen(wss), { backoffMs: () => 60 }),
    );
    hub.start();
    await vi.waitFor(() => expect(hub.reconnecting).toBe(true));
    hub.stop();
    await new Promise((r) => setTimeout(r, 150));
    expect(connections).toBe(1);
  });

  it("delivers decoded frames and survives a throwing onFrame", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    wss.on("connection", (ws) => {
      ws.send("not json");
      ws.send(JSON.stringify({ v: 1, id: "x", type: "hello" })); // daemon->hub type
      ws.send(
        JSON.stringify({
          v: 1,
          id: "1",
          type: "roster_changed",
          namespace: "n",
        }),
      );
      ws.send(
        JSON.stringify({
          v: 1,
          id: "2",
          type: "roster_changed",
          namespace: "m",
        }),
      );
    });
    const got: unknown[] = [];
    const log = vi.fn();
    const hub = new HubConnection(
      opts(await listen(wss), {
        log,
        onFrame: (f) => {
          got.push(f);
          throw new Error("consumer bug");
        },
      }),
    );
    hub.start();
    await vi.waitFor(() => expect(got.length).toBe(2));
    expect(got[0]).toMatchObject({ type: "roster_changed", namespace: "n" });
    expect(hub.open).toBe(true);
    expect(JSON.stringify(log.mock.calls)).not.toContain("oa_machine_x");
    hub.stop();
  });
});

describe("a frame the encoder refuses", () => {
  it("is not sent, is logged without its body, and the daemon keeps going", async () => {
    const { encodeFrame } = await import("@oa/bus-protocol");
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const url = await listen(wss);
    const seen: { type: string; body?: string }[] = [];
    wss.on("connection", (ws) =>
      ws.on("message", (d) => seen.push(JSON.parse(String(d)))),
    );
    const log = vi.fn();
    let opened!: () => void;
    const open = new Promise<void>((r) => {
      opened = r;
    });
    const hub = new HubConnection(
      opts(url, {
        log,
        onOpen: () => opened(),
        encode: (f) => {
          if (f.type === "send") throw new RangeError("lone surrogate");
          return encodeFrame(f);
        },
      }),
    );
    hub.start();
    await open;
    const ok = hub.send({
      v: 1,
      id: "s1",
      type: "send",
      from_ref: "a1",
      to_name: "peer",
      body: "SECRET-BODY",
    });
    expect(ok).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/could not encode/));
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET-BODY");
    expect(hub.send({ v: 1, id: "l1", type: "list", from_ref: "a1" })).toBe(
      true,
    );
    await vi.waitFor(() => expect(types(seen)).toContain("list"));
    expect(types(seen)).not.toContain("send");
    hub.stop();
  });
});

describe("pacing and rate limits", () => {
  it("queues a burst behind hello and sessions, paced, and refuses when closed", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const seen: { type: string; at: number }[] = [];
    wss.on("connection", (ws) =>
      ws.on("message", (d) =>
        seen.push({ type: JSON.parse(String(d)).type, at: Date.now() }),
      ),
    );
    const accepted: boolean[] = [];
    let opened!: () => void;
    const open = new Promise<void>((r) => {
      opened = r;
    });
    const h2: HubConnection = new HubConnection(
      opts(await listen(wss), {
        onOpen: () => {
          for (let i = 0; i < 60; i++)
            accepted.push(
              h2.send({ v: 1, id: `l${i}`, type: "list", from_ref: "a1" }),
            );
          opened();
        },
      }),
    );
    expect(h2.send({ v: 1, id: "l0", type: "list", from_ref: "a1" })).toBe(
      false,
    );
    h2.start();
    await open;
    expect(accepted.every(Boolean)).toBe(true);
    await vi.waitFor(() => expect(seen.length).toBe(62), { timeout: 5000 });
    expect(types(seen).slice(0, 2)).toEqual(["hello", "sessions"]);
    // 62 frames at 35/s after a burst of 5: well over a second.
    expect(seen[61].at - seen[0].at).toBeGreaterThan(1000);
    h2.stop();
  });

  it("drops what is queued when the link closes", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let conns = 0;
    const seen: string[] = [];
    wss.on("connection", (ws) => {
      conns++;
      ws.on("message", (d) => seen.push(JSON.parse(String(d)).id));
    });
    let opened!: () => void;
    const open = new Promise<void>((r) => {
      opened = r;
    });
    const hub = new HubConnection(
      opts(await listen(wss), {
        onOpen: () => {
          if (conns > 1) return;
          for (let i = 0; i < 50; i++)
            hub.send({ v: 1, id: `q${i}`, type: "list", from_ref: "a1" });
          opened();
        },
        backoffMs: () => 10,
      }),
    );
    hub.start();
    await open;
    for (const c of wss.clients) c.terminate();
    await vi.waitFor(() => expect(conns).toBe(2));
    await new Promise((r) => setTimeout(r, 1500));
    expect(seen.filter((id) => id.startsWith("q")).length).toBeLessThan(50);
    hub.stop();
  });

  it("waits longer after a 'rate limited' close and logs it once", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const at: number[] = [];
    wss.on("connection", (ws) => {
      at.push(Date.now());
      ws.close(1008, "rate limited");
    });
    const log = vi.fn();
    const hub = new HubConnection(
      opts(await listen(wss), {
        log,
        backoffMs: () => 10,
        rateLimitedMs: 300,
      }),
    );
    hub.start();
    await vi.waitFor(() => expect(at.length).toBe(3), { timeout: 3000 });
    await vi.waitFor(() => expect(hub.lastError).toBe("rate limited"));
    hub.stop();
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(290);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(290);
    expect(log.mock.calls.filter(([m]) => /rate limited/.test(m))).toHaveLength(
      1,
    );
  });

  it.each([["bad frame"], [""]])(
    "a 4429 close (reason %j) waits at least the cooldown",
    async (reason) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      const at: number[] = [];
      wss.on("connection", (ws) => {
        at.push(Date.now());
        ws.close(LIMITS.rateLimitCloseCode, reason);
      });
      const hub = new HubConnection(
        opts(await listen(wss), { backoffMs: () => 10, rateLimitedMs: 300 }),
      );
      hub.start();
      // Read before the second connection opens: its `open` clears lastError.
      await vi.waitFor(() => expect(hub.lastError).toBe("rate limited"));
      await vi.waitFor(() => expect(at.length).toBe(2), { timeout: 3000 });
      hub.stop();
      expect(at[1] - at[0]).toBeGreaterThanOrEqual(290);
    },
  );

  it.each([
    [0, 1],
    [1, 1.5],
  ])(
    "the default cooldown is the shared one plus jitter (random %d)",
    async (random, factor) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      wss.on("connection", (ws) => ws.close(LIMITS.rateLimitCloseCode));
      const hub = new HubConnection(
        opts(await listen(wss), { backoffMs: () => 10, stableMs: 60_000 }),
      );
      const spy = vi.spyOn(globalThis, "setTimeout");
      vi.spyOn(Math, "random").mockReturnValue(random);
      hub.start();
      const expected = LIMITS.rateLimitCooldownMs * factor;
      await vi.waitFor(() =>
        expect(spy.mock.calls.map(([, ms]) => ms)).toContain(expected),
      );
      hub.stop();
      vi.restoreAllMocks();
    },
  );

  it("an upgrade answered 429 is a cooldown, never a revoke", async () => {
    const at: number[] = [];
    const { createServer } = await import("node:http");
    const http = createServer((_req, res) => {
      at.push(Date.now());
      res.writeHead(429).end();
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const port = (http.address() as { port: number }).port;
    const onRevoked = vi.fn();
    const hub = new HubConnection(
      opts(`ws://127.0.0.1:${port}`, {
        backoffMs: () => 10,
        rateLimitedMs: 300,
        onRevoked,
      }),
    );
    hub.start();
    await vi.waitFor(() => expect(at.length).toBe(2), { timeout: 3000 });
    hub.stop();
    http.close();
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(290);
    expect(hub.lastError).toBe("rate limited");
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it("an upgrade answered 401 revokes", async () => {
    const { createServer } = await import("node:http");
    const http = createServer((_req, res) =>
      res.writeHead(401, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: { code: "unauthorized", message: "Invalid machine token" },
        }),
      ),
    );
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const port = (http.address() as { port: number }).port;
    const onRevoked = vi.fn();
    const hub = new HubConnection(
      opts(`ws://127.0.0.1:${port}`, { onRevoked }),
    );
    hub.start();
    await vi.waitFor(() => expect(onRevoked).toHaveBeenCalled());
    hub.stop();
    http.close();
  });

  it("a plain 1008 close keeps the normal backoff", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const at: number[] = [];
    wss.on("connection", (ws) => {
      at.push(Date.now());
      ws.close(1008, "bad frame");
    });
    const hub = new HubConnection(
      opts(await listen(wss), { backoffMs: () => 10, rateLimitedMs: 5000 }),
    );
    hub.start();
    await vi.waitFor(() => expect(at.length).toBeGreaterThanOrEqual(2), {
      timeout: 2000,
    });
    expect(at[1] - at[0]).toBeLessThan(1000);
    hub.stop();
  });
});

describe("revoke paths: the daemon's marker and whether it reconnects", () => {
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(stops.splice(0).map((s) => s()));
    await stopAll();
  });

  const TOKEN = "oa_machine_SECRETSECRETSECRET";

  /** A daemon on an empty temp home: the harness's hub, or `hub` (never answered 101). */
  async function daemon(hub?: string) {
    const home = mkdtempSync(join(tmpdir(), "ob-rv-"));
    vi.stubEnv("OA_BUS_HOME", home);
    const marker = join(home, "revoked");
    const onRevoked = vi.fn();
    if (!hub) {
      const h = await daemonHarness({ revokedFile: marker, onRevoked });
      return { h, marker, onRevoked };
    }
    const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
    const d = await runDaemon({
      config: { hub, machine_id: "m1", label: "laptop", machine_token: TOKEN },
      socketPath: join(tmp("ob-d-"), "d.sock"),
      revokedFile: marker,
      onRevoked,
      hub: { backoffMs: () => 20 },
      sentFile: join(tmp("ob-sf-"), "sent.json"),
      attest: () => ({ ok: true }),
      resolveNamespace: () => ({
        namespace: "ns",
        global: false,
        source: "cwd",
      }),
      claude: {
        sessionsDir: tmp("ob-cs-"),
        socketsDir: join(tmp("ob-cr-"), "r"),
        heldFile: join(tmp("ob-ch-"), "held.json"),
      },
      opencode: {
        presenceDir: tmp("ob-ot-"),
        spawn: async () => {
          throw new Error("no opencode in tests");
        },
        version: async () => "2.0.32",
        uncertainFile: join(tmp("ob-ou-"), "u.json"),
      },
    });
    stops.push(d.stop);
    return { h: undefined, marker, onRevoked };
  }

  /** An HTTP server answering every upgrade with `status`; counts the attempts. */
  async function refusing(status: number, body = "") {
    const hits = { n: 0 };
    const http = httpServer((_req, res) => {
      hits.n++;
      res.writeHead(status).end(body);
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const port = (http.address() as { port: number }).port;
    return { http, hits, url: `http://127.0.0.1:${port}` };
  }

  it("an upgrade answered 401 is a revoke: marker written, no reconnect", async () => {
    const hub = await refusing(
      401,
      JSON.stringify({
        error: { code: "unauthorized", message: "Invalid machine token" },
      }),
    );
    try {
      const { marker, onRevoked } = await daemon(hub.url);
      await vi.waitFor(() => expect(onRevoked).toHaveBeenCalledOnce());
      process.exitCode = 0;
      expect(JSON.parse(readFileSync(marker, "utf8")).token_sha256).toBe(
        tokenHash(TOKEN),
      );
      await new Promise((r) => setTimeout(r, 120));
      expect(hub.hits.n).toBe(1);
    } finally {
      hub.http.close();
    }
  });

  it("an upgrade answered 403 is transient: no marker, it reconnects with backoff", async () => {
    const hub = await refusing(403, "<html>Error 1020: Access denied</html>");
    try {
      const { marker, onRevoked } = await daemon(hub.url);
      await vi.waitFor(() => expect(hub.hits.n).toBeGreaterThanOrEqual(3), {
        timeout: 2000,
      });
      expect(onRevoked).not.toHaveBeenCalled();
      expect(existsSync(marker)).toBe(false);
    } finally {
      hub.http.close();
    }
  });

  it(`a live socket closed with ${LIMITS.revokeCloseCode} is a revoke: marker written, no reconnect`, async () => {
    const { h, marker, onRevoked } = await daemon();
    const first = h?.hubSock();
    first?.close(LIMITS.revokeCloseCode, "revoked");
    await vi.waitFor(() => expect(onRevoked).toHaveBeenCalledOnce());
    process.exitCode = 0;
    expect(JSON.parse(readFileSync(marker, "utf8")).token_sha256).toBe(
      tokenHash(TOKEN),
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(h?.hubSock()).toBe(first);
  });
});
