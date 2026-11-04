import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { connectDaemon, type DaemonClient, Hello } from "@oa/bus-ipc";
import {
  type ClientFrame,
  decodeClientFrame,
  encodeFrame,
  newMachineToken,
  PING,
  PONG,
  type ServerFrame,
} from "@oa/bus-protocol";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import type { DeliverFn, Mail } from "../src/deliver.ts";
import {
  claudeProcStartOf,
  type Daemon,
  procStartOf,
  runDaemon,
} from "../src/index.ts";

// The tripwire: HOME is an empty dir for this whole file, so anything the
// daemon writes outside its own temp OA_BUS_HOME lands here and fails the run.
const realHome = homedir();
const saved = {
  HOME: process.env.HOME,
  OA_BUS_CLAUDE_SESSIONS_DIR: process.env.OA_BUS_CLAUDE_SESSIONS_DIR,
  OA_BUS_HOME: process.env.OA_BUS_HOME,
  OA_BUS_HUB: process.env.OA_BUS_HUB,
};
const SENTINEL_HOME = mkdtempSync(join(tmpdir(), "obs-"));
process.env.HOME = SENTINEL_HOME;
delete process.env.OA_BUS_HUB;
delete process.env.OA_BUS_CLAUDE_SESSIONS_DIR;

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const NS = "e2e-local";
const PI_REF = "pi-e2e-1";
const CLAUDE_REF = "0b6c4f1e-claude-e2e";
const OC_REF = "ses_opencode_e2e";
const NAMES = { [PI_REF]: "pi", [CLAUDE_REF]: "claude", [OC_REF]: "oc" };
/** A wire msg_id (base58, so no 0) numbered n. */
const ids = (n: number) =>
  `mmmmmmmmmmmmm${String(n)
    .padStart(3, "0")
    .replace(/\d/g, (d) => "123456789A"[Number(d)] as string)}`;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  // Nothing escaped into the real home's stand-in.
  expect(readdirSync(SENTINEL_HOME, { recursive: true })).toEqual([]);
});

/** A hub that checks every daemon frame against the shared wire schema and routes sends by name. */
async function fakeHub() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const frames: ClientFrame[] = [];
  const bad: string[] = [];
  const byName = new Map<string, string>();
  let sock: WebSocket | undefined;
  let seq = 0;
  const toDaemon = (f: ServerFrame) => (sock as WebSocket).send(encodeFrame(f));
  wss.on("connection", (ws) => {
    sock = ws;
    ws.on("message", (d) => {
      const text = String(d);
      if (text === PING) return ws.send(PONG);
      const r = decodeClientFrame(text);
      if (!r.ok) return void bad.push(text);
      const f = r.frame;
      frames.push(f);
      if (f.type === "agent_up") byName.set(f.proposed_name, f.agent_ref);
      // The hub tells the sender once the recipient's daemon acks (B6).
      if (f.type === "ack")
        toDaemon({
          v: 1,
          id: `u-${f.msg_id}`,
          type: "receipt_update",
          msg_id: f.msg_id,
          state: "delivered",
        });
      if (f.type === "send" && hub.routeSends) {
        const to = byName.get(f.to_name);
        const msg_id = ids(++seq);
        toDaemon({ v: 1, id: f.id, type: "receipt", msg_id, state: "pending" });
        if (to)
          toDaemon({
            v: 1,
            id: `d-${msg_id}`,
            type: "deliver",
            msg_id,
            to_ref: to,
            from_name: NAMES[f.from_ref as keyof typeof NAMES],
            namespace: NS,
            body: f.body,
          });
      }
    });
  });
  const hub = {
    url: `http://127.0.0.1:${(wss.address() as { port: number }).port}`,
    frames,
    bad,
    routeSends: true,
    toDaemon,
    of: <T extends ClientFrame["type"]>(type: T) =>
      frames.filter(
        (f): f is Extract<ClientFrame, { type: T }> => f.type === type,
      ),
    close: () => new Promise<void>((r) => wss.close(() => r())),
  };
  return hub;
}

async function boot() {
  const root = mkdtempSync(join(tmpdir(), "obe-"));
  const home = join(root, "h");
  const project = join(root, "project");
  const claudeSessions = join(root, "claude-sessions");
  for (const d of [home, project, claudeSessions])
    mkdirSync(d, { mode: 0o700 });
  expect(home).not.toBe(join(realHome, ".oa-bus"));
  expect(homedir()).toBe(SENTINEL_HOME);
  process.env.OA_BUS_HOME = home;
  writeFileSync(
    join(project, ".oa-bus.json"),
    JSON.stringify({ namespace: NS }),
    { mode: 0o600 },
  );

  const hub = await fakeHub();
  cleanups.push(hub.close);
  // machine.json as `npx @open-artifacts/bus login` writes it: 0600, a well-formed token, this hub.
  writeFileSync(
    join(home, "machine.json"),
    JSON.stringify({
      hub: hub.url,
      machine_id: "m1m1m1m1m1m1m1m1",
      label: "e2e",
      machine_token: newMachineToken(),
    }),
  );
  chmodSync(join(home, "machine.json"), 0o600);

  // A Claude session as Claude records it: this process, its real UTC start.
  const sessionFile = join(claudeSessions, `${process.pid}.json`);
  writeFileSync(
    sessionFile,
    JSON.stringify({
      pid: process.pid,
      sessionId: CLAUDE_REF,
      procStart: claudeProcStartOf(process.pid),
      cwd: project,
      name: NAMES[CLAUDE_REF],
    }),
  );

  // Claude and OpenCode inject through their transports; Pi over the real ipc connection.
  const injected = { claude: [] as Mail[], opencode: [] as Mail[] };
  const claudeT = vi.fn<DeliverFn>(async (_a, mail) => {
    injected.claude.push(mail);
    return { ok: true };
  });
  const opencodeT = vi.fn<DeliverFn>(async (_a, mail) => {
    injected.opencode.push(mail);
    return { ok: true };
  });
  const logs: string[] = [];
  const daemon: Daemon = await runDaemon({
    log: (m) => logs.push(m),
    hub: { backoffMs: () => 20 },
    deliveredWaitMs: 300,
    transports: { "claude-code": claudeT, opencode: opencodeT },
    claude: { sessionsDir: claudeSessions, syncMs: 50 },
    opencode: {
      // An OpenCode service above the adapter, with its session open in a TUI.
      ancestors: (pid) => [pid],
      comm: (pid) => (pid === process.pid ? "/opt/bin/opencode" : null),
      openSessions: () => new Set([OC_REF]),
      spawn: async () => {
        throw new Error("no opencode in tests");
      },
      version: async () => "2.0.32",
    },
  });
  cleanups.push(() => daemon.stop());
  await vi.waitFor(() => expect(daemon.hub.open).toBe(true));

  const clients: DaemonClient[] = [];
  cleanups.push(() => {
    for (const c of clients) c.close();
  });
  const connect = async (hello: Record<string, unknown>) => {
    const c = await connectDaemon({
      path: join(home, "daemon.sock"),
      hello: Hello.parse({
        v: 1,
        id: `h-${hello.agent_ref}`,
        type: "hello",
        pid: process.pid,
        cwd: project,
        ...hello,
      }),
    });
    clients.push(c);
    return c;
  };
  const pi = await connect({
    kind: "pi",
    agent_ref: PI_REF,
    proposed_name: NAMES[PI_REF],
    attest: { proc_start: procStartOf(process.pid) },
  });
  const claude = await connect({ kind: "claude-code", agent_ref: CLAUDE_REF });
  const opencode = await connect({
    kind: "opencode",
    agent_ref: OC_REF,
    proposed_name: NAMES[OC_REF],
    attest: { session_id: OC_REF },
  });
  // Every adapter is an agent on the hub before anything is sent.
  await vi.waitFor(() =>
    expect(
      [...new Set(hub.of("agent_up").map((f) => f.agent_ref))].sort(),
    ).toEqual([CLAUDE_REF, OC_REF, PI_REF].sort()),
  );
  for (const f of hub.of("agent_up")) expect(f.namespace).toBe(NS);
  return {
    hub,
    daemon,
    pi,
    claude,
    opencode,
    injected,
    claudeT,
    opencodeT,
    sessionFile,
    logs,
  };
}

describe("daemon end to end, one machine, three harnesses", () => {
  it("carries one message each way between pi, claude-code and opencode", async () => {
    const e = await boot();
    const piGot: { from_name: string; body?: string; msg_id: string }[] = [];
    e.pi.onDeliver((f) => {
      piGot.push(f);
      e.pi.ack(f.msg_id);
    });

    // pi -> claude -> opencode -> pi: every kind sends once and receives once,
    // and each sender hears it was delivered.
    expect(
      await e.pi.request({ type: "send", to: "claude", body: "from pi" }),
    ).toMatchObject({ type: "receipt", state: "delivered" });
    expect(
      await e.claude.request({ type: "send", to: "oc", body: "from claude" }),
    ).toMatchObject({ type: "receipt", state: "delivered" });
    expect(
      await e.opencode.request({ type: "send", to: "pi", body: "from oc" }),
    ).toMatchObject({ type: "receipt", state: "delivered" });

    await vi.waitFor(() => expect(e.hub.of("ack")).toHaveLength(3));
    expect(e.injected.claude).toEqual([
      expect.objectContaining({
        from_name: "pi",
        body: "from pi",
        namespace: NS,
      }),
    ]);
    expect(e.injected.opencode).toEqual([
      expect.objectContaining({ from_name: "claude", body: "from claude" }),
    ]);
    expect(piGot).toEqual([
      expect.objectContaining({ from_name: "oc", body: "from oc" }),
    ]);
    // Attribution is the daemon's: each send names the session that made it.
    expect(e.hub.of("send").map((f) => [f.from_ref, f.to_name])).toEqual([
      [PI_REF, "claude"],
      [CLAUDE_REF, "oc"],
      [OC_REF, "pi"],
    ]);
    expect(e.hub.of("refuse")).toEqual([]);
    expect(e.hub.bad).toEqual([]);
  });

  it("acks a duplicate delivery twice and injects it once", async () => {
    const e = await boot();
    const piGot: string[] = [];
    let ackNow!: () => void;
    const acked = new Promise<void>((r) => {
      ackNow = r;
    });
    e.pi.onDeliver((f) => {
      piGot.push(f.msg_id);
      // The extension acks once pi took it; the redelivery lands before that.
      void acked.then(() => e.pi.ack(f.msg_id));
    });
    const deliver = (
      id: string,
      msg_id = ids(900),
      to_ref = PI_REF,
    ): ServerFrame => ({
      v: 1,
      id,
      type: "deliver",
      msg_id,
      to_ref,
      from_name: "claude",
      namespace: NS,
      body: "hello",
    });
    e.hub.toDaemon(deliver("d1"));
    await vi.waitFor(() => expect(piGot).toHaveLength(1));
    e.hub.toDaemon(deliver("d2"));
    // The daemon handles hub frames in order, each synchronously up to its
    // first await: once a later probe is refused, d2 has joined the attempt.
    e.hub.toDaemon(deliver("probe", ids(999), "nobody"));
    await vi.waitFor(() =>
      expect(e.hub.of("refuse").map((f) => f.msg_id)).toEqual([ids(999)]),
    );
    expect(e.hub.of("ack")).toEqual([]);
    ackNow();
    await vi.waitFor(() => expect(e.hub.of("ack")).toHaveLength(2));
    // And once more after it settled, as a hub retry after a lost ack would.
    e.hub.toDaemon(deliver("d3"));
    await vi.waitFor(() => expect(e.hub.of("ack")).toHaveLength(3));
    expect(e.hub.of("ack").map((f) => f.msg_id)).toEqual([
      ids(900),
      ids(900),
      ids(900),
    ]);
    expect(piGot).toEqual([ids(900)]);
    expect(e.hub.bad).toEqual([]);
  });

  it("refuses mail for a closed session and injects nothing", async () => {
    const e = await boot();
    // The Claude session ends: its file goes, and the daemon tells the hub.
    rmSync(e.sessionFile);
    await vi.waitFor(() =>
      expect(e.hub.of("sessions").at(-1)?.closed).toContain(CLAUDE_REF),
    );
    // Pi's last connection closes: that session is closed too.
    e.pi.close();
    await vi.waitFor(() =>
      expect(e.hub.of("sessions").at(-1)?.closed).toEqual(
        expect.arrayContaining([CLAUDE_REF, PI_REF]),
      ),
    );
    for (const [n, to_ref] of [
      [901, CLAUDE_REF],
      [902, PI_REF],
    ] as const)
      e.hub.toDaemon({
        v: 1,
        id: `d-${n}`,
        type: "deliver",
        msg_id: ids(n),
        to_ref,
        from_name: "oc",
        namespace: NS,
        body: "anyone there?",
      });
    await vi.waitFor(() => expect(e.hub.of("refuse")).toHaveLength(2));
    expect(e.hub.of("refuse")).toEqual([
      expect.objectContaining({
        msg_id: ids(901),
        reason: "closed",
        detail: "dropped",
      }),
      expect.objectContaining({
        msg_id: ids(902),
        reason: "closed",
        detail: "dropped",
      }),
    ]);
    expect(e.claudeT).not.toHaveBeenCalled();
    expect(e.hub.of("ack")).toEqual([]);
    expect(e.hub.bad).toEqual([]);
  });

  it("tells the sender exactly once when its mail expires, quoting it", async () => {
    const e = await boot();
    e.hub.routeSends = false;
    const notices: string[] = [];
    e.pi.onNotice((t) => notices.push(t));
    const reply = e.pi.request({
      type: "send",
      to: "claude",
      body: "please review the release notes before Friday's cut",
    });
    await vi.waitFor(() => expect(e.hub.of("send")).toHaveLength(1));
    const sent = e.hub.of("send")[0] as Extract<ClientFrame, { type: "send" }>;
    e.hub.toDaemon({
      v: 1,
      id: sent.id,
      type: "receipt",
      msg_id: ids(903),
      state: "pending",
    });
    expect(await reply).toMatchObject({ type: "receipt", state: "pending" });
    const expired: ServerFrame = {
      v: 1,
      id: "u1",
      type: "receipt_update",
      msg_id: ids(903),
      state: "expired",
    };
    e.hub.toDaemon(expired);
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    // The same update again is about mail already told: nothing more.
    e.hub.toDaemon({ ...expired, id: "u2" });
    await new Promise((r) => setTimeout(r, 150));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(
      /^×\s+Expired: your message to claude, "please review/,
    );
    expect(notices[0]).toContain("was not taken within 1 hour.");
    expect(e.claudeT).not.toHaveBeenCalled();
    expect(e.hub.bad).toEqual([]);
  });
});
