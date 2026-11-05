// C5 hardening: identity, liveness, return sockets, restarts and failure classes.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cachedProcStart,
  claudeTarget,
  liveClaudeSessions,
} from "../src/liveness/claude.ts";
import { ClaudeTransport } from "../src/transports/claude.ts";
import { daemonHarness, deliverFrame, stopAll } from "./helpers.ts";

const dir = () => mkdtempSync(join(tmpdir(), "ob-adv5-"));
const servers: Server[] = [];
const transports: ClaudeTransport[] = [];
const paused: Socket[] = [];
afterEach(async () => {
  for (const s of paused.splice(0)) s.destroy();
  await Promise.all(transports.splice(0).map((t) => t.close()));
  await stopAll();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

const writeSession = (d: string, pid: number, over: object = {}) =>
  writeFileSync(
    join(d, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: `s${pid}`,
      procStart: "t0",
      name: "npm-test",
      messagingSocketPath: `/tmp/cc-socks/${pid}.sock`,
      cwd: "/repo",
      ...over,
    }),
  );
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const agent = {
  ref: "s1",
  kind: "claude-code",
  proposedName: "a",
  busName: "a",
  namespace: "n",
  global: true,
  pid: 1,
  cwd: "/",
  live: true,
} as const;

/** A fake Claude inbox; `onMessage` may answer on the from= socket. */
async function fakeClaude(onMessage?: (msgId: string, from: string) => void) {
  const d = dir();
  const sock = join(d, "claude.sock");
  const seen: { msgId: string; from: string }[] = [];
  const server = createServer((s) => {
    s.on("error", () => {}); // peer resets are not the test
    createInterface({ input: s }).on("line", (line) => {
      const f = JSON.parse(line) as Record<string, unknown>;
      if (f.type !== "user") return;
      const e = {
        msgId: String(f.msg_id),
        from: String(f.from).replace(/^uds:/, ""),
      };
      seen.push(e);
      onMessage?.(e.msgId, e.from);
    });
  });
  await new Promise<void>((r) => server.listen(sock, () => r()));
  servers.push(server);
  return { d, sock, seen };
}
const transportFor = (
  f: { d: string; sock: string },
  over: Partial<ConstructorParameters<typeof ClaudeTransport>[0]> = {},
) => {
  const t = new ClaudeTransport({
    socketsDir: join(f.d, `sinks-${transports.length}`),
    heldFile: join(f.d, "claude-held.json"),
    statusWindowMs: 40,
    target: () => ({ socketPath: f.sock, peerToken: "tok" }),
    ...over,
  });
  transports.push(t);
  return t;
};

describe("C5 adversarial: identity and liveness", () => {
  it("accepts the MCP hello of a session resumed under a new pid between sync ticks", async () => {
    const d = dir();
    writeSession(d, 4242, { sessionId: "sX" });
    const running = new Set([4242]);
    let attestedPid = 4242;
    const h = await daemonHarness({
      claude: {
        sessionsDir: d,
        socketsDir: join(d, "sinks"),
        syncMs: 20,
        procStart: (pid) => (running.has(pid) ? "t0" : null),
        isRunning: (pid) => running.has(pid),
      },
      attest: () => ({ ok: true, cwd: "/repo", pid: attestedPid }),
    });
    await h.next("agent_up");
    // `claude --resume sX`: the old process exits and the new one appears inside one tick.
    writeSession(d, 5151, { sessionId: "sX" });
    rmSync(join(d, "4242.json"));
    running.delete(4242);
    running.add(5151);
    attestedPid = 5151;
    await new Promise((r) => setTimeout(r, 150)); // many sync ticks
    expect(h.daemon.agents.byRef("sX")?.pid).toBe(5151);
    const a = await h.adapter("sX", { pid: 9999 });
    expect(a.welcome).toMatchObject({ agent_ref: "sX" });
  });

  it("does not treat a session file without procStart as live when the pid's start differs", () => {
    const d = dir();
    writeSession(d, 4242, { procStart: undefined });
    const live = liveClaudeSessions({
      dir: d,
      procStart: () => "a reused pid's start",
      isRunning: () => true,
    });
    expect(live).toEqual([]);
  });

  it("does not use a peerToken from a .key written by an earlier process", () => {
    const d = dir();
    const sock = "/tmp/cc-socks/4242.sock";
    writeSession(d, 4242, { messagingSocketPath: sock });
    writeFileSync(
      join(d, `4242.${sha(sock)}.key`),
      JSON.stringify({
        peerToken: "stale",
        procStart: "t-old",
        pidDomain: "x",
      }),
    );
    expect(
      claudeTarget("s4242", {
        dir: d,
        procStart: () => "t0",
        isRunning: () => true,
      }),
    ).toBeNull();
  });

  it("resolving one delivery target runs ps only for that session", () => {
    const d = dir();
    for (let pid = 1000; pid < 1020; pid += 1) writeSession(d, pid);
    const procStart = vi.fn(() => "t0");
    claudeTarget("s1000", { dir: d, procStart, isRunning: () => true });
    expect(procStart.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("C5 adversarial: return sockets and delivery", () => {
  it("gives same-named peers from different namespaces different return sockets", async () => {
    const f = await fakeClaude();
    const t = transportFor(f);
    const base = { from_name: "alice", body: "hi" };
    await t.deliver(agent, { ...base, msg_id: "m1", namespace: "ns1" });
    await t.deliver(agent, { ...base, msg_id: "m2", namespace: "ns2" });
    expect(f.seen).toHaveLength(2);
    // Same sink ⇒ Claude's reply to ns2's alice is routed as a reply to "alice", whichever the hub picks.
    expect(f.seen[0].from).not.toBe(f.seen[1].from);
  });

  it("does not re-inject a held message after a daemon restart", async () => {
    const holdFrom = (to: string, id: string, claudeSock: string) => {
      const s = connect(to);
      s.on("error", () => {});
      s.once("connect", () =>
        s.end(
          `${JSON.stringify({
            msgV: 1,
            type: "control",
            action: "peer_message_status",
            orig_msg_id: id,
            status: "held",
            from: `uds:${claudeSock}`,
          })}\n`,
        ),
      );
    };
    let sock = "";
    const f = await fakeClaude((id, from) => holdFrom(from, id, sock));
    sock = f.sock;
    const mail = { msg_id: "m1", from_name: "peer", namespace: "n", body: "x" };
    // A status window wide enough that a slow "held" is never read as silence.
    const first = transportFor(f, { statusWindowMs: 30_000 });
    const p = first.deliver(agent, mail);
    await vi.waitFor(() => expect(f.seen).toHaveLength(1));
    const held = join(f.d, "claude-held.json");
    await vi.waitFor(() => expect(readFileSync(held, "utf8")).toContain("m1"));
    await first.close(); // daemon upgrade/restart
    expect(await p).toEqual({ ok: false, reason: "timeout" }); // hub will redeliver
    // The restarted daemon gets the hub's redelivery while Claude still holds the first copy.
    expect(await transportFor(f).deliver(agent, mail)).toEqual({
      ok: false,
      reason: "closed",
      cause: "expired",
    });
    expect(f.seen).toHaveLength(1);
    expect(statSync(held).mode & 0o777).toBe(0o600);
  });
});

const holdingClaude = async () => {
  let sock = "";
  const f = await fakeClaude((id, from) => {
    const s = connect(from);
    s.on("error", () => {});
    s.once("connect", () =>
      s.end(
        `${JSON.stringify({
          msgV: 1,
          type: "control",
          action: "peer_message_status",
          orig_msg_id: id,
          status: "held",
          from: `uds:${sock}`,
        })}\n`,
      ),
    );
  });
  sock = f.sock;
  return f;
};
const mail = (msg_id = "m1") => ({
  msg_id,
  from_name: "peer",
  namespace: "n",
  body: "x",
});

describe("C5 hardening: held messages across restarts", () => {
  it("prunes held entries older than an hour", async () => {
    const f = await holdingClaude();
    const held = join(f.d, "claude-held.json");
    writeFileSync(
      held,
      JSON.stringify({ m1: Date.now() - 2 * 3_600_000, m2: Date.now() }),
    );
    const t = transportFor(f);
    expect(await t.deliver(agent, mail("m2"))).toEqual({
      ok: false,
      reason: "closed",
      cause: "expired",
    });
    // m1's hold is long gone: a redelivery injects normally, and is held anew.
    void t.deliver(agent, mail("m1"));
    await vi.waitFor(() => expect(f.seen.map((s) => s.msgId)).toEqual(["m1"]));
    await vi.waitFor(() => {
      const at = JSON.parse(readFileSync(held, "utf8")).m1 as number;
      expect(Date.now() - at).toBeLessThan(60_000);
    });
  });

  it("a second daemon sharing the home refuses a held redelivery as expired, never injecting or acking", async () => {
    const f = await holdingClaude();
    const sessions = dir();
    writeSession(sessions, 4242, { messagingSocketPath: f.sock });
    writeFileSync(
      join(sessions, `4242.${sha(f.sock)}.key`),
      JSON.stringify({ peerToken: "tok", procStart: "t0" }),
    );
    const claude = {
      sessionsDir: sessions,
      socketsDir: join(f.d, "r"),
      heldFile: join(f.d, "claude-held.json"),
      statusWindowMs: 40,
      procStart: () => "t0",
      isRunning: () => true,
    };
    const one = await daemonHarness({ claude });
    await one.next("agent_up");
    one.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1", "s4242"));
    await vi.waitFor(() => expect(f.seen).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100)); // held
    await one.daemon.stop();

    const two = await daemonHarness({ claude });
    await two.next("agent_up");
    two.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1", "s4242"));
    expect(await two.next("refuse")).toMatchObject({
      msg_id: "mmmmmmmmmmmmmmm1",
      reason: "closed",
      detail: "expired",
    });
    expect(f.seen).toHaveLength(1);
    expect([...one.of("ack"), ...two.of("ack")]).toEqual([]);
    expect(two.daemon.agents.byRef("s4242")?.live).toBe(true);
  });
});

describe("C5 hardening: injection failure classes", () => {
  it("a socket nobody listens on is closed", async () => {
    const d = dir();
    const stale = join(d, "stale.sock");
    // A listener killed without unlinking leaves a socket that refuses.
    spawnSync(process.execPath, [
      "-e",
      `require("net").createServer().listen(${JSON.stringify(stale)}, () => process.kill(process.pid, "SIGKILL"))`,
    ]);
    expect(statSync(stale).isSocket()).toBe(true);
    const t = transportFor({ d, sock: stale });
    expect(await t.deliver(agent, mail())).toEqual({
      ok: false,
      reason: "closed",
    });
  });

  it("a stalled write after connecting is a retryable timeout", async () => {
    const d = dir();
    const sock = join(d, "c.sock");
    const server = createServer((s) => {
      s.on("error", () => {}); // peer resets are not the test
      paused.push(s);
      s.pause();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(sock, () => r()));
    const t = transportFor({ d, sock }, { injectTimeoutMs: 100 });
    expect(
      await t.deliver(agent, { ...mail(), body: "x".repeat(8 * 1024 * 1024) }),
    ).toEqual({ ok: false, reason: "timeout" });
  });

  it("a reset after connecting is a retryable timeout", async () => {
    const d = dir();
    const sock = join(d, "c.sock");
    const server = createServer((s) => {
      s.on("error", () => {});
      s.destroy();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(sock, () => r()));
    const t = transportFor({ d, sock });
    expect(
      await t.deliver(agent, { ...mail(), body: "x".repeat(8 * 1024 * 1024) }),
    ).toEqual({ ok: false, reason: "timeout" });
  });

  it("keeps the session live when an injection times out", async () => {
    const d = dir();
    const sock = join(d, "c.sock");
    const server = createServer((s) => {
      s.on("error", () => {}); // peer resets are not the test
      paused.push(s);
      s.pause();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(sock, () => r()));
    writeSession(d, 4242, { messagingSocketPath: sock });
    writeFileSync(
      join(d, `4242.${sha(sock)}.key`),
      JSON.stringify({ peerToken: "tok", procStart: "t0" }),
    );
    const h = await daemonHarness({
      claude: {
        sessionsDir: d,
        socketsDir: join(d, "r"),
        injectTimeoutMs: 100,
        procStart: () => "t0",
        isRunning: () => true,
      },
    });
    await h.next("agent_up");
    h.toDaemon({
      ...deliverFrame("mmmmmmmmmmmmmmm1", "s4242"),
      body: "x".repeat(200_000),
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(h.of("refuse")).toEqual([]);
    expect(h.of("ack")).toEqual([]);
    expect(h.daemon.agents.byRef("s4242")?.live).toBe(true);
  });

  it("a return socket dir too long for sun_path disables the transport once, at start", async () => {
    const f = await fakeClaude();
    const log = vi.fn();
    const t = transportFor(f, {
      socketsDir: join(f.d, "x".repeat(120)),
      log,
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/too long/));
    // Refused, but not as a closed session: the session itself is fine.
    for (const id of ["m1", "m2"])
      expect(await t.deliver(agent, mail(id))).toEqual({
        ok: false,
        reason: "closed",
        cause: "dropped",
      });
    expect(log).toHaveBeenCalledTimes(1);
    expect(f.seen).toEqual([]);
  });

  it("runDaemon keeps Claude sessions live when the transport is disabled", async () => {
    const d = dir();
    writeSession(d, 4242);
    const log = vi.fn();
    const h = await daemonHarness({
      log,
      claude: {
        sessionsDir: d,
        socketsDir: join(d, "y".repeat(120)),
        procStart: () => "t0",
        isRunning: () => true,
      },
    });
    await h.next("agent_up");
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1", "s4242"));
    expect(await h.next("refuse")).toMatchObject({ detail: "dropped" });
    expect(h.daemon.agents.byRef("s4242")?.live).toBe(true);
    expect(log.mock.calls.filter(([m]) => /too long/.test(m))).toHaveLength(1);
  });
});

describe("C5 hardening: session files", () => {
  it("a session file without procStart is not live", () => {
    const d = dir();
    writeSession(d, 4242, { procStart: undefined });
    expect(
      liveClaudeSessions({
        dir: d,
        procStart: () => "t0",
        isRunning: () => true,
      }),
    ).toEqual([]);
  });

  it("a .key without the session's procStart gives no token", () => {
    const d = dir();
    const sock = "/tmp/cc-socks/4242.sock";
    writeSession(d, 4242, { messagingSocketPath: sock });
    const deps = { dir: d, procStart: () => "t0", isRunning: () => true };
    writeFileSync(
      join(d, `4242.${sha(sock)}.key`),
      JSON.stringify({ peerToken: "tok" }),
    );
    expect(claudeTarget("s4242", deps)).toBeNull();
    writeFileSync(
      join(d, `4242.${sha(sock)}.key`),
      JSON.stringify({ peerToken: "tok", procStart: "t0" }),
    );
    expect(claudeTarget("s4242", deps)).toEqual({
      socketPath: sock,
      peerToken: "tok",
    });
  });

  it("re-reads procStart when the session file's stamp changes", () => {
    const ps = vi.fn(() => "s");
    const cached = cachedProcStart(ps, () => true);
    cached(7, "a");
    cached(7, "a");
    expect(ps).toHaveBeenCalledTimes(1);
    cached(7, "b");
    expect(ps).toHaveBeenCalledTimes(2);
  });

  it("a session file rewritten for a reused pid is judged against a fresh ps", () => {
    const d = dir();
    writeSession(d, 4242, { procStart: "old" });
    let start = "old";
    const cached = cachedProcStart(
      () => start,
      () => true,
    );
    const deps = { dir: d, procStart: cached, isRunning: () => true };
    expect(liveClaudeSessions(deps)).toHaveLength(1);
    // The pid is reused by a new Claude session before any tick saw it stop.
    start = "new";
    writeSession(d, 4242, { procStart: "new", sessionId: "s-new" });
    expect(liveClaudeSessions(deps).map((s) => s.ref)).toEqual(["s-new"]);
  });

  it("asks again once an entry is a sync interval old, so a pid reused between ticks is caught", () => {
    let t = 0;
    let start = "old";
    const ps = vi.fn(() => start);
    const cached = cachedProcStart(ps, () => true, {
      ttlMs: 2000,
      now: () => t,
    });
    expect(cached(7, "a")).toBe("old");
    t = 1999;
    start = "new"; // reused, same file stamp
    expect(cached(7, "a")).toBe("old");
    t = 2000;
    expect(cached(7, "a")).toBe("new");
    expect(ps).toHaveBeenCalledTimes(2);
  });

  it("drops a Claude session whose pid was reused between ticks, file untouched", () => {
    const d = dir();
    writeSession(d, 4242, { procStart: "old" });
    let t = 0;
    let start = "old";
    const deps = {
      dir: d,
      procStart: cachedProcStart(
        () => start,
        () => true,
        { ttlMs: 2000, now: () => t },
      ),
      isRunning: () => true,
    };
    expect(liveClaudeSessions(deps)).toHaveLength(1);
    start = "new";
    t = 2000;
    expect(liveClaudeSessions(deps)).toEqual([]);
  });

  it("caches procStart per running pid and forgets a pid that stopped", () => {
    const running = new Set([7]);
    const ps = vi.fn((pid: number) => `start-${pid}`);
    const cached = cachedProcStart(ps, (pid) => running.has(pid));
    expect(cached(7)).toBe("start-7");
    expect(cached(7)).toBe("start-7");
    expect(ps).toHaveBeenCalledTimes(1);
    running.delete(7);
    expect(cached(7)).toBeNull();
    running.add(7);
    expect(cached(7)).toBe("start-7");
    expect(ps).toHaveBeenCalledTimes(2);
  });

  it("the daemon reads OA_BUS_CLAUDE_SESSIONS_DIR when no dir is given", async () => {
    const d = dir();
    writeSession(d, 4242);
    const prev = process.env.OA_BUS_CLAUDE_SESSIONS_DIR;
    process.env.OA_BUS_CLAUDE_SESSIONS_DIR = d;
    try {
      const h = await daemonHarness({
        claude: {
          sessionsDir: undefined,
          socketsDir: join(d, "r"),
          procStart: () => "t0",
          isRunning: () => true,
        },
      });
      expect(await h.next("agent_up")).toMatchObject({ agent_ref: "s4242" });
    } finally {
      if (prev === undefined) delete process.env.OA_BUS_CLAUDE_SESSIONS_DIR;
      else process.env.OA_BUS_CLAUDE_SESSIONS_DIR = prev;
    }
  });

  it("keeps the current pid while two live files share a sessionId", async () => {
    const d = dir();
    writeSession(d, 4242, { sessionId: "sX" });
    const running = new Set([4242]);
    const h = await daemonHarness({
      claude: {
        sessionsDir: d,
        socketsDir: join(d, "r"),
        syncMs: 20,
        procStart: (pid) => (running.has(pid) ? "t0" : null),
        isRunning: (pid) => running.has(pid),
      },
    });
    await h.next("agent_up");
    for (const pid of [1111, 5151, 9999]) {
      writeSession(d, pid, { sessionId: "sX" });
      running.add(pid);
    }
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 25));
      expect(h.daemon.agents.byRef("sX")?.pid).toBe(4242);
    }
    running.delete(4242);
    await vi.waitFor(() =>
      expect(h.daemon.agents.byRef("sX")?.pid).not.toBe(4242),
    );
    const next = h.daemon.agents.byRef("sX")?.pid;
    await new Promise((r) => setTimeout(r, 100));
    expect(h.daemon.agents.byRef("sX")?.pid).toBe(next);
  });

  it("accepts the resumed session's MCP hello before the next sync tick", async () => {
    const d = dir();
    writeSession(d, 4242, { sessionId: "sX" });
    const running = new Set([4242]);
    const h = await daemonHarness({
      claude: {
        sessionsDir: d,
        socketsDir: join(d, "sinks"),
        syncMs: 60_000,
        procStart: (pid) => (running.has(pid) ? "t0" : null),
        isRunning: (pid) => running.has(pid),
      },
      attest: () => ({ ok: true, cwd: "/repo", pid: 5151 }),
    });
    await h.next("agent_up");
    writeSession(d, 5151, { sessionId: "sX" });
    rmSync(join(d, "4242.json"));
    running.delete(4242);
    running.add(5151);
    const a = await h.adapter("sX", { pid: 9999 });
    expect(a.welcome).toMatchObject({ agent_ref: "sX" });
    expect(h.daemon.agents.byRef("sX")).toMatchObject({
      pid: 5151,
      live: true,
    });
  });
});

describe("C5 hardening: replies while the hub is down", () => {
  it("queues a native reply and sends it once the hub is back", async () => {
    const d = dir();
    const sock = join(d, "c.sock");
    let replyTo = "";
    const server = createServer((s) => {
      s.on("error", () => {}); // peer resets are not the test
      createInterface({ input: s }).on("line", (line) => {
        const f = JSON.parse(line) as Record<string, unknown>;
        if (f.type === "user") replyTo = String(f.from).replace(/^uds:/, "");
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(sock, () => r()));
    writeSession(d, 4242, { messagingSocketPath: sock });
    writeFileSync(
      join(d, `4242.${sha(sock)}.key`),
      JSON.stringify({ peerToken: "tok", procStart: "t0" }),
    );
    const h = await daemonHarness({
      claude: {
        sessionsDir: d,
        socketsDir: join(d, "r"),
        statusWindowMs: 20,
        procStart: () => "t0",
        isRunning: () => true,
      },
      hub: { backoffMs: () => 400 },
    });
    await h.next("agent_up");
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1", "s4242"));
    await h.next("ack");
    h.hubSock()?.terminate();
    await vi.waitFor(() => expect(h.daemon.hub.open).toBe(false));
    const back = connect(replyTo);
    await new Promise<void>((r) => back.once("connect", () => r()));
    back.end(
      `${JSON.stringify({
        msgV: 1,
        type: "user",
        message: {
          role: "user",
          content: `<cross-session-message from="uds:${sock}" from-name="npm-test">\npong\n</cross-session-message>`,
        },
        from: `uds:${sock}`,
      })}\n`,
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(h.of("send")).toEqual([]);
    // The new link's hello_ok says what the hub takes: then the reply goes.
    await vi.waitFor(() => expect(h.daemon.hub.open).toBe(true));
    h.toDaemon({
      id: "w",
      type: "hello_ok",
      machine_id: "1".repeat(16),
      machine_label: "laptop",
      server_version: "1",
    });
    expect(await h.next("send")).toMatchObject({
      from_ref: "s4242",
      to_name: "peer",
      body: "pong",
    });
  });
});

describe("native replies must be well-formed unicode", () => {
  it("a session name cut at 64 units never leaves half an emoji, and a lone surrogate is replaced", async () => {
    const d = dir();
    writeSession(d, 4242, { name: `${"a".repeat(63)}😀` });
    writeSession(d, 4343, { sessionId: "s4343", name: "bad\ud800name" });
    const h = await daemonHarness({
      claude: {
        sessionsDir: d,
        procStart: () => "t0",
        isRunning: () => true,
      },
    });
    await h.next("agent_up", 2);
    const names = h.of("agent_up").map((f) => f.proposed_name);
    expect(names).toContain("a".repeat(63));
    expect(names).toContain("bad\ufffdname");
  });

  it("sends a reply with a lone surrogate with U+FFFD in its place, and logs it", async () => {
    const d = dir();
    const sock = join(d, "c.sock");
    let replyTo = "";
    const server = createServer((s) => {
      s.on("error", () => {}); // peer resets are not the test
      createInterface({ input: s }).on("line", (line) => {
        const f = JSON.parse(line) as Record<string, unknown>;
        if (f.type === "user") replyTo = String(f.from).replace(/^uds:/, "");
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(sock, () => r()));
    writeSession(d, 4242, { messagingSocketPath: sock });
    writeFileSync(
      join(d, `4242.${sha(sock)}.key`),
      JSON.stringify({ peerToken: "tok", procStart: "t0" }),
    );
    const log = vi.fn();
    const h = await daemonHarness({
      log,
      claude: {
        sessionsDir: d,
        socketsDir: join(d, "r"),
        statusWindowMs: 20,
        procStart: () => "t0",
        isRunning: () => true,
      },
    });
    await h.next("agent_up");
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1", "s4242"));
    await h.next("ack");
    const reply = async (text: string) => {
      const back = connect(replyTo);
      await new Promise<void>((r) => back.once("connect", () => r()));
      back.end(
        `${JSON.stringify({
          msgV: 1,
          type: "user",
          message: {
            role: "user",
            content: `<cross-session-message from="uds:${sock}" from-name="npm-test">\n${text}\n</cross-session-message>`,
          },
          from: `uds:${sock}`,
        })}\n`,
      );
    };
    h.toDaemon({
      id: "w",
      type: "hello_ok",
      machine_id: "1".repeat(16),
      machine_label: "laptop",
      server_version: "1",
    });
    await reply("po\ud800ng");
    expect(await h.next("send")).toMatchObject({ body: "po\ufffdng" });
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/reply to peer was not well-formed unicode/),
    );
    await reply("pong 😀");
    expect(await h.next("send", 2)).toMatchObject({ body: "pong 😀" });
  });
});

describe("C5 hardening: held file failures", () => {
  it("a held file that cannot be written never causes a second injection", async () => {
    const f = await holdingClaude();
    const notADir = join(f.d, "file");
    writeFileSync(notADir, "");
    const log = vi.fn();
    const t = transportFor(f, {
      heldFile: join(notADir, "claude-held.json"),
      statusWindowMs: 200,
      log,
    });
    const first = t.deliver(agent, mail());
    await vi.waitFor(() => expect(f.seen).toHaveLength(1));
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/held/)),
    );
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    // Still held in memory: a redelivery joins it instead of injecting.
    const second = t.deliver(agent, mail());
    await new Promise((r) => setTimeout(r, 100));
    expect(settled).toBe(false);
    expect(f.seen).toHaveLength(1);
    await t.close();
    expect(await first).toEqual({ ok: false, reason: "timeout" });
    expect(await second).toEqual({ ok: false, reason: "timeout" });
  });
});
