import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectDaemon, type DaemonClient, type Hello } from "@oa/bus-ipc";
import type { ClientFrame as DaemonToHub } from "@oa/bus-protocol";
import { PING, PONG } from "@oa/bus-protocol";
import { expect, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import type { HubOptions } from "../src/hub.ts";
import { type DaemonDeps, runDaemon } from "../src/index.ts";

export const servers: { close: (cb: () => void) => void }[] = [];
export async function closeAll() {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
}
export async function wsServer(): Promise<{
  wss: WebSocketServer;
  url: string;
}> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);
  if (!wss.address())
    await new Promise<void>((r) => wss.once("listening", () => r()));
  return {
    wss,
    url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}/hub`,
  };
}
export function opts(url: string, over: Partial<HubOptions> = {}): HubOptions {
  return {
    url,
    token: "oa_machine_SECRETSECRETSECRET",
    label: "laptop",
    version: "0.1.0",
    sessions: () => ({ open: [], closed: [] }),
    onFrame: () => {},
    onRevoked: () => {},
    onOpen: () => {},
    backoffMs: () => 20,
    ...over,
  };
}
export const deliver = (msg_id: string) =>
  JSON.stringify({
    v: 1,
    id: "d1",
    type: "deliver",
    msg_id,
    to_ref: "a1",
    from_name: "x",
    namespace: "n",
    body: "hi",
  });
export const hello = (over: Partial<Hello>): Hello => ({
  v: 1,
  id: "h",
  type: "hello",
  kind: "claude-code",
  agent_ref: "ref",
  pid: process.pid,
  cwd: process.cwd(),
  attest: {},
  ...over,
});

/** runDaemon against a stub ws hub on 127.0.0.1, with attestation and namespaces stubbed. */
export async function daemonHarness(over: Partial<DaemonDeps> = {}) {
  const { wss, url } = await wsServer();
  const frames: DaemonToHub[] = [];
  /** Each frame as written, in order. */
  const raw: string[] = [];
  let hubSock: WebSocket | undefined;
  /** The path and Authorization of every upgrade the daemon made, in order. */
  const upgrades: { path: string | undefined; auth: string | undefined }[] = [];
  wss.on("connection", (ws, req) => {
    upgrades.push({ path: req.url, auth: req.headers.authorization });
    hubSock = ws;
    ws.on("message", (d) => {
      const text = String(d);
      if (text === PING) ws.send(PONG);
      else {
        raw.push(text);
        frames.push(JSON.parse(text));
      }
    });
  });
  const path = join(mkdtempSync(join(tmpdir(), "ob-d-")), "d.sock");
  const daemon = await runDaemon({
    config: {
      // The instance origin: the daemon dials its /bus/connect.
      hub: url.replace(/\/hub$/, ""),
      machine_id: "m1",
      label: "laptop",
      machine_token: "oa_machine_SECRETSECRETSECRET",
    },
    socketPath: path,
    attest: () => ({ ok: true }),
    resolveNamespace: () => ({ namespace: "ns", global: false, source: "cwd" }),
    hub: { backoffMs: () => 20 },
    sentFile: join(mkdtempSync(join(tmpdir(), "ob-sf-")), "sent.json"),
    // A queued send answers at once unless a test waits for delivered (C17).
    deliveredWaitMs: 0,
    ...over,
    // Never the real ~/.claude/sessions or ~/.oa-bus: temp ones, unless a test brings its own.
    claude: {
      sessionsDir: mkdtempSync(join(tmpdir(), "ob-cs-")),
      socketsDir: join(mkdtempSync(join(tmpdir(), "ob-cr-")), "r"),
      heldFile: join(mkdtempSync(join(tmpdir(), "ob-ch-")), "held.json"),
      ...over.claude,
    },
    // Never a real `opencode` or the real presence files.
    opencode: {
      presenceDir: mkdtempSync(join(tmpdir(), "ob-ot-")),
      spawn: async () => {
        throw new Error("no opencode in tests");
      },
      version: async () => "2.0.32",
      uncertainFile: join(mkdtempSync(join(tmpdir(), "ob-ou-")), "u.json"),
      ...over.opencode,
    },
    // Never the user's `codex` or ~/.codex.
    codex: {
      home: mkdtempSync(join(tmpdir(), "ob-cx-")),
      resolveBin: () => undefined,
      run: async () => {
        throw new Error("no codex in tests");
      },
      queuedFile: join(mkdtempSync(join(tmpdir(), "ob-cq-")), "q.json"),
      ...over.codex,
    },
  });
  stops.push(daemon.stop);
  await vi.waitFor(() => expect(daemon.hub.open).toBe(true));
  const adapter = (agent_ref: string, over: Partial<Hello> = {}) =>
    connectDaemon({ path, hello: hello({ agent_ref, ...over }) }).then((c) => {
      clients.push(c);
      return c;
    });
  const of = <T extends DaemonToHub["type"]>(type: T) =>
    frames.filter(
      (f): f is Extract<DaemonToHub, { type: T }> => f.type === type,
    );
  const next = async <T extends DaemonToHub["type"]>(type: T, n = 1) => {
    await vi.waitFor(() => expect(of(type).length).toBeGreaterThanOrEqual(n));
    return of(type)[n - 1] as Extract<DaemonToHub, { type: T }>;
  };
  const toDaemon = (f: object) =>
    (hubSock as WebSocket).send(JSON.stringify({ v: 1, ...f }));
  return {
    daemon,
    socketPath: path,
    wss,
    frames,
    raw,
    of,
    next,
    toDaemon,
    adapter,
    hubSock: () => hubSock,
    upgrades,
  };
}

const stops: (() => Promise<void>)[] = [];
const clients: DaemonClient[] = [];
export async function stopAll() {
  for (const c of clients.splice(0)) c.close();
  await Promise.all(stops.splice(0).map((s) => s()));
  await closeAll();
}

export const deliverFrame = (msg_id: string, to_ref = "A") => ({
  id: `d-${msg_id}`,
  type: "deliver",
  msg_id,
  to_ref,
  from_name: "peer",
  namespace: "ns",
  body: "hi",
});
