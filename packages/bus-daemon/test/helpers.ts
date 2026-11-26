import { mkdtempSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectDaemon, type DaemonClient, type Hello } from "@oa/bus-ipc";
import type { ClientFrame as DaemonToHub } from "@oa/bus-protocol";
import { PING, PONG } from "@oa/bus-protocol";
import { expect, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { HubOptions } from "../src/hub.ts";
import { type DaemonDeps, runDaemon } from "../src/index.ts";

/**
 * A connection made now is accepted after any connect the client began before
 * it (one listen backlog, in order): once it is in, a reconnect that was on its
 * way would already have been counted. Probes are not counted by the servers.
 */
export const PROBE = "/probe";
export async function probeWs(url: string) {
  const ws = new WebSocket(url.replace(/\/hub$/, PROBE));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.close();
}
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
  /** Called with each frame as it arrives, before `of` can see the next one. */
  const frameListeners = new Set<(f: DaemonToHub) => void>();
  const onFrame = (fn: (f: DaemonToHub) => void) => {
    frameListeners.add(fn);
    return () => frameListeners.delete(fn);
  };
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
        const f = JSON.parse(text) as DaemonToHub;
        frames.push(f);
        for (const fn of frameListeners) fn(f);
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
    sentFile: join(mkdtempSync(join(tmpdir(), "ob-sf-")), "sent.json"),
    // #3028: never the real ~/.oa-bus/announced.json: a temp one, unless a test
    // brings its own (a restart test shares one across two runs).
    announcedFile: join(
      mkdtempSync(join(tmpdir(), "ob-an-")),
      "announced.json",
    ),
    // A queued send answers at once unless a test waits for delivered (C17).
    deliveredWaitMs: 0,
    ...over,
    // Reconnects at once, and no frame waits for a pacing token: a frame the
    // daemon wrote is on the wire, so `quiet()` fences it. A test of pacing
    // brings its own `pace`.
    hub: {
      backoffMs: () => 0,
      pace: { burst: 10_000, rate: 10_000 },
      ...over.hub,
    },
    // Never the real ~/.claude/sessions or ~/.oa-bus: temp ones, unless a test brings its own.
    claude: {
      sessionsDir: mkdtempSync(join(tmpdir(), "ob-cs-")),
      // #2806: the harness's home is a temp one; adopt scanned sessions as
      // the default home does, and never read a real process's environment.
      discover: true,
      homeOf: () => undefined,
      socketsDir: join(mkdtempSync(join(tmpdir(), "ob-cr-")), "r"),
      heldFile: join(mkdtempSync(join(tmpdir(), "ob-ch-")), "held.json"),
      linksFile: join(
        mkdtempSync(join(tmpdir(), "ob-cl-")),
        "claude-links.json",
      ),
      // #2793 S3b: never the real guests file, transcripts or Claude settings.
      guestsFile: join(
        mkdtempSync(join(tmpdir(), "ob-cg-")),
        "claude-guests.json",
      ),
      stashFile: join(
        mkdtempSync(join(tmpdir(), "ob-cs2-")),
        "claude-stash.json",
      ),
      projectsDir: mkdtempSync(join(tmpdir(), "ob-cp-")),
      mcpConfigFile: join(
        mkdtempSync(join(tmpdir(), "ob-cm-")),
        ".claude.json",
      ),
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
      takenFile: join(mkdtempSync(join(tmpdir(), "ob-ct-")), "p.json"),
      agentsFile: join(
        mkdtempSync(join(tmpdir(), "ob-ca-")),
        "codex-agents.json",
      ),
      awayFile: join(mkdtempSync(join(tmpdir(), "ob-cw-")), "codex-away.json"),
      wokenFile: join(
        mkdtempSync(join(tmpdir(), "ob-cn-")),
        "codex-woken.json",
      ),
      ...over.codex,
    },
  });
  stops.push(daemon.stop);
  // The hello is the first thing the hub link writes once open: wake on it.
  if (!frames.some((f) => f.type === "hello"))
    await new Promise<void>((resolve) => {
      const off = onFrame((f) => {
        if (f.type !== "hello") return;
        off();
        resolve();
      });
    });
  expect(daemon.hub.open).toBe(true);
  /** #1608: a pi-like adapter echoes the binding token its first welcome issued; pass `bind_token: undefined` to be a stranger. */
  const tokens = new Map<string, string>();
  const adapter = (agent_ref: string, over: Partial<Hello> = {}) =>
    connectDaemon({
      path,
      hello: hello({
        agent_ref,
        ...("bind_token" in over || !tokens.has(agent_ref)
          ? {}
          : { bind_token: tokens.get(agent_ref) }),
        ...over,
      }),
    }).then((c) => {
      clients.push(c);
      if (c.welcome.bind_token !== undefined)
        tokens.set(agent_ref, c.welcome.bind_token);
      return c;
    });
  const of = <T extends DaemonToHub["type"]>(type: T) =>
    frames.filter(
      (f): f is Extract<DaemonToHub, { type: T }> => f.type === type,
    );
  const next = async <T extends DaemonToHub["type"]>(type: T, n = 1) => {
    // Woken by the frame itself, never by a clock.
    if (of(type).length < n)
      await new Promise<void>((resolve) => {
        const off = onFrame(() => {
          if (of(type).length < n) return;
          off();
          resolve();
        });
      });
    return of(type)[n - 1] as Extract<DaemonToHub, { type: T }>;
  };
  const toDaemon = (f: object) =>
    (hubSock as WebSocket).send(JSON.stringify({ v: 1, ...f }));
  /**
   * Resolves once every frame the daemon had already written to the hub link
   * has been received here: a websocket ping is answered by the client at
   * once, and the stream is in order. The signal for "nothing was sent":
   * check `of(...)` after it.
   */
  const barrier = () =>
    new Promise<void>((resolve) => {
      const ws = hubSock as WebSocket;
      ws.once("pong", () => resolve());
      ws.ping();
    });
  /**
   * Fences the frames sent to the daemon so far: the daemon's websocket
   * receiver answers a ping only after it dispatched every message before it,
   * so once this resolves the daemon's synchronous (and microtask-only)
   * reaction to each earlier frame has run, and what it sent the hub has
   * arrived. Valid only for a reaction that needs no timer and no later I/O;
   * anything that does waits on its own window (fake time, or the event that
   * ends it), never on this.
   */
  const quiet = () => barrier();
  return {
    daemon,
    barrier,
    quiet,
    onFrame,
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

/**
 * Resolves once the daemon has answered a fresh connection on its socket (a
 * frame before any hello is refused). The daemon handles what became ready
 * earlier, such as a client that hung up, before a connection made after it.
 */
export function ipcBarrier(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = createConnection(socketPath);
    c.once("error", reject);
    c.once("data", () => {
      c.destroy();
      resolve();
    });
    c.once("connect", () =>
      c.write(`${JSON.stringify({ v: 1, id: "barrier", type: "self" })}\n`),
    );
  });
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

/**
 * A counter of events a test waits on instead of sleeping: `hook` is passed to
 * a daemon seam (`claude.onSync`, `claude.onLineHandled`); `next(n)` resolves
 * once n more events have happened since the call (or since `mark()`).
 */
export function eventCounter() {
  let count = 0;
  const waiters: { at: number; resolve: () => void }[] = [];
  return {
    hook: () => {
      count++;
      for (const w of waiters.splice(0)) {
        if (count >= w.at) w.resolve();
        else waiters.push(w);
      }
    },
    get count() {
      return count;
    },
    /** Resolves after n more events (default 1) from now. */
    next: (n = 1) =>
      new Promise<void>((resolve) => {
        waiters.push({ at: count + n, resolve });
      }),
    /** Resolves once the total count reaches n. */
    reach: (n: number) =>
      count >= n
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ at: n, resolve });
          }),
  };
}
