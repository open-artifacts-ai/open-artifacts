// I8: client adversarial pass before production. Each test pins a finding and
// is `it.fails` until its fix lands; flip it to `it` then.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newMachineToken } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attest } from "../src/attest.ts";
import { readConfig } from "../src/config.ts";
import { HubConnection } from "../src/hub.ts";
import { ClaudeTransport } from "../src/transports/claude.ts";
import { daemonHarness, hello, opts, stopAll } from "./helpers.ts";

const servers: Server[] = [];
const transports: ClaudeTransport[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(transports.splice(0).map((t) => t.close()));
  await stopAll();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe("I8: revoke recovery", () => {
  it("a revoke of the token this daemon started with never blocks the newer token `login` saved since", async () => {
    // `oa-bus login` (or `login --hub new`) wrote a fresh token while the
    // daemon kept running on the old one; the user then revoked the old,
    // now duplicate, machine row in the dashboard.
    const home = tmp("ob-i8-rv-");
    vi.stubEnv("OA_BUS_HOME", home);
    vi.stubEnv("OA_BUS_HUB", "");
    const onRevoked = vi.fn();
    const h = await daemonHarness({
      revokedFile: join(home, "revoked"),
      onRevoked,
    });
    writeFileSync(
      join(home, "machine.json"),
      JSON.stringify({
        hub: "https://bus.example.com",
        machine_id: "m2",
        label: "laptop",
        machine_token: newMachineToken(),
      }),
      { mode: 0o600 },
    );
    h.hubSock()?.close(4403, "revoked");
    await vi.waitFor(() => expect(onRevoked).toHaveBeenCalledOnce());
    process.exitCode = 0;
    // The marker names no token, so the next start refuses the valid one.
    expect(() => readConfig()).not.toThrow();
  });

  it("a 403 at the upgrade that is not the hub's answer (a WAF or proxy page) is not a revoke", async () => {
    // The contract's answer to an unknown or revoked token is 401 `unauthorized`.
    let hits = 0;
    const http = httpServer((_req, res) => {
      hits++;
      res
        .writeHead(403, { "content-type": "text/html" })
        .end("<html>Error 1020: Access denied</html>");
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const port = (http.address() as { port: number }).port;
    const onRevoked = vi.fn();
    const hub = new HubConnection(
      opts(`ws://127.0.0.1:${port}/hub`, { onRevoked, backoffMs: () => 20 }),
    );
    hub.start();
    try {
      await vi.waitFor(() => expect(hits).toBeGreaterThanOrEqual(2), {
        timeout: 1500,
      });
      expect(onRevoked).not.toHaveBeenCalled();
    } finally {
      hub.stop();
      http.close();
    }
  });

  it("a machine.json with no hub never sends its token to whatever OA_BUS_HUB names", () => {
    const home = tmp("ob-i8-cfg-");
    writeFileSync(
      join(home, "machine.json"),
      JSON.stringify({
        machine_id: "m",
        label: "laptop",
        machine_token: newMachineToken(),
      }),
      { mode: 0o600 },
    );
    vi.stubEnv("OA_BUS_HOME", home);
    vi.stubEnv("OA_BUS_HUB", "wss://elsewhere.example.net");
    expect(() => readConfig()).toThrow();
  });
});

describe("I8: attestation", () => {
  it("an unreadable nearest session file never lets an outer session be claimed", () => {
    // pid 200 is a nested Claude whose session file is mid-write; 100 is the
    // outer session. The MCP server (300) runs under the nested one.
    const dir = tmp("ob-i8-at-");
    writeFileSync(join(dir, "200.json"), '{"pid":200,"sessionId":"inn');
    writeFileSync(
      join(dir, "100.json"),
      JSON.stringify({
        pid: 100,
        sessionId: "outer",
        procStart: "x",
        cwd: "/repo",
      }),
    );
    const r = attest(
      hello({ kind: "claude-code", agent_ref: "outer", pid: 300 }),
      {
        sessionsDir: dir,
        ancestors: () => [300, 200, 100],
        procStart: () => "x",
      },
    );
    expect(r.ok).toBe(false);
  });
});

describe("I8: Claude's own socket", () => {
  it("never hands a peerToken and a body to a socket in a folder other users can write", async () => {
    // Claude's socket lives in /tmp/cc-socks. A folder another user made or
    // can write lets them swap the socket and read every injected message.
    const d = tmp("ob-i8-cc-");
    const socks = join(d, "cc-socks");
    mkdirSync(socks);
    chmodSync(socks, 0o777);
    const sock = join(socks, "4242.sock");
    const seen: string[] = [];
    const server = createServer((s) => {
      s.on("error", () => {});
      s.on("data", (b) => seen.push(String(b)));
    });
    await new Promise<void>((r) => server.listen(sock, () => r()));
    servers.push(server);
    const t = new ClaudeTransport({
      socketsDir: join(d, "sinks"),
      heldFile: join(d, "held.json"),
      statusWindowMs: 40,
      target: () => ({ socketPath: sock, peerToken: "tok" }),
    });
    transports.push(t);
    const out = await t.deliver(
      {
        ref: "s1",
        kind: "claude-code",
        proposedName: "a",
        busName: "a",
        namespace: "n",
        global: false,
        pid: 1,
        cwd: "/",
        live: true,
      },
      { msg_id: "m1", from_name: "alice", namespace: "n", body: "secret" },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.join("")).not.toContain("tok");
    expect(out.ok).toBe(false);
  });
});
