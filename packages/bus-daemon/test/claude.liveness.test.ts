import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeTarget, liveClaudeSessions } from "../src/liveness/claude.ts";
import { ClaudeTransport } from "../src/transports/claude.ts";
import { daemonHarness, deliverFrame, stopAll } from "./helpers.ts";

const dir = () => mkdtempSync(join(tmpdir(), "ob-live-"));
const servers: Server[] = [];
afterEach(async () => {
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

describe("claude liveness", () => {
  it("lists a live session with its bus name and socket", () => {
    const d = dir();
    writeSession(d, 4242);
    const live = liveClaudeSessions({
      dir: d,
      procStart: () => "t0",
      isRunning: () => true,
    });
    expect(live).toEqual([
      {
        ref: "s4242",
        name: "npm-test",
        pid: 4242,
        socketPath: "/tmp/cc-socks/4242.sock",
        cwd: "/repo",
      },
    ]);
  });

  it("drops a dead pid, a moved procStart, a parked job and a wire-invalid ref", () => {
    const d = dir();
    writeSession(d, 4242);
    const live = (over: object = {}) =>
      liveClaudeSessions({
        dir: d,
        procStart: () => "t0",
        isRunning: () => true,
        ...over,
      });
    expect(live({ procStart: () => "t1" })).toEqual([]);
    expect(live({ procStart: () => null })).toEqual([]);
    expect(live({ isRunning: () => false })).toEqual([]);
    writeSession(d, 4242, { parkedJobId: "j" });
    expect(live()).toEqual([]);
    writeSession(d, 4242, { sessionId: "bad ref/../x" });
    expect(live()).toEqual([]);
    writeSession(d, 4242, { agentBus: true });
    expect(live()).toEqual([]);
  });

  it("lists a session without a socket, which can send but not receive", () => {
    const d = dir();
    writeSession(d, 4242, { messagingSocketPath: undefined });
    const deps = { dir: d, procStart: () => "t0", isRunning: () => true };
    expect(liveClaudeSessions(deps)).toMatchObject([{ socketPath: "" }]);
    expect(claudeTarget("s4242", deps)).toBeNull();
  });

  it("a gone Claude process is refused closed and nothing is injected", async () => {
    const d = dir();
    const sock = join(d, "claude.sock");
    const seen: string[] = [];
    const server = createServer((s) => {
      s.on("error", () => {});
      s.on("data", (b) => seen.push(String(b)));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(sock, () => r()));
    writeSession(d, 4242, { messagingSocketPath: sock });
    let running = true;
    const deps = {
      dir: d,
      procStart: () => "t0",
      isRunning: () => running,
      sha256: () => "h",
    };
    writeFileSync(
      join(d, "4242.h.key"),
      JSON.stringify({ peerToken: "tok", procStart: "t0" }),
    );
    const t = new ClaudeTransport({
      socketsDir: join(d, "sinks"),
      statusWindowMs: 20,
      target: (ref) => claudeTarget(ref, deps),
    });
    const agent = {
      ref: "s4242",
      kind: "claude-code",
      proposedName: "a",
      busName: "a",
      namespace: "ns",
      global: false,
      pid: 4242,
      cwd: "/repo",
      live: true,
    } as const;
    const mail = (msg_id: string) => ({
      msg_id,
      from_name: "peer",
      namespace: "ns",
      body: "hi",
    });

    expect(await t.deliver(agent, mail("m1"))).toEqual({ ok: true });
    await vi.waitFor(() => expect(seen.join("")).toContain('"m1"'));

    running = false;
    seen.length = 0;
    expect(await t.deliver(agent, mail("m2"))).toEqual({
      ok: false,
      reason: "closed",
    });
    await new Promise((r) => setTimeout(r, 50)); // absence: an injection would land here
    expect(seen).toEqual([]);

    // A key file gone with the session is just as closed.
    running = true;
    rmSync(join(d, "4242.h.key"));
    expect(await t.deliver(agent, mail("m3"))).toEqual({
      ok: false,
      reason: "closed",
    });
    expect(seen).toEqual([]);
    await t.close();
  });
});

describe("runDaemon claude session sync", () => {
  const syncDeps = (d: string, running: Set<number>) => ({
    sessionsDir: d,
    socketsDir: join(d, "sinks"),
    syncMs: 20,
    procStart: (pid: number) => (running.has(pid) ? "t0" : null),
    isRunning: (pid: number) => running.has(pid),
  });

  it("announces a session once, before any tool call, and closes it when it goes", async () => {
    const d = dir();
    writeSession(d, 4242);
    const running = new Set([4242]);
    const h = await daemonHarness({ claude: syncDeps(d, running) });
    expect(await h.next("agent_up")).toMatchObject({
      agent_ref: "s4242",
      kind: "claude-code",
      proposed_name: "npm-test",
      namespace: "ns",
    });
    expect(h.daemon.agents.byRef("s4242")).toMatchObject({
      pid: 4242,
      live: true,
    });
    await new Promise((r) => setTimeout(r, 100)); // several sync ticks
    expect(h.of("agent_up")).toHaveLength(1);

    running.delete(4242);
    await vi.waitFor(() =>
      expect(h.of("sessions").at(-1)).toMatchObject({ closed: ["s4242"] }),
    );
    expect(h.daemon.agents.byRef("s4242")?.live).toBe(false);
    const downs = h.of("sessions").length;
    await new Promise((r) => setTimeout(r, 100));
    expect(h.of("sessions")).toHaveLength(downs); // reported once
  });

  it("refuses a delivery to a session whose process is gone, injecting nothing", async () => {
    const d = dir();
    writeSession(d, 4242);
    const running = new Set([4242]);
    const h = await daemonHarness({
      claude: { ...syncDeps(d, running), syncMs: 60_000 },
    });
    await h.next("agent_up");
    running.delete(4242); // gone before the next sync tick
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1", "s4242"));
    expect(await h.next("refuse")).toMatchObject({
      msg_id: "mmmmmmmmmmmmmmm1",
      reason: "closed",
      detail: "dropped",
    });
    expect(h.of("ack")).toEqual([]);
  });

  it("re-announces a closed session that comes back under a new process", async () => {
    const d = dir();
    writeSession(d, 4242);
    const running = new Set([4242]);
    const h = await daemonHarness({ claude: syncDeps(d, running) });
    await h.next("agent_up");
    running.delete(4242);
    await vi.waitFor(() =>
      expect(h.daemon.agents.byRef("s4242")?.live).toBe(false),
    );
    rmSync(join(d, "4242.json"));
    writeSession(d, 5151, { sessionId: "s4242" });
    running.add(5151);
    expect(await h.next("agent_up", 2)).toMatchObject({ agent_ref: "s4242" });
    expect(h.daemon.agents.byRef("s4242")).toMatchObject({
      pid: 5151,
      live: true,
    });
  });

  it("accepts the session's MCP hello after the daemon announced it", async () => {
    const d = dir();
    writeSession(d, 4242);
    const h = await daemonHarness({
      claude: syncDeps(d, new Set([4242])),
      attest: () => ({ ok: true, cwd: "/repo", pid: 4242 }),
    });
    await h.next("agent_up");
    const a = await h.adapter("s4242", { pid: 9999 }); // the MCP server's own pid
    expect(a.welcome).toMatchObject({ agent_ref: "s4242", namespace: "ns" });
    a.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(h.of("agent_up")).toHaveLength(1);
    expect(h.daemon.agents.byRef("s4242")).toMatchObject({
      pid: 4242,
      live: true,
    });
  });

  it.each([
    [false, "ns"],
    [false, "ns2"], // a non-global session replying to a global peer in another namespace
    [true, "ns"],
  ])(
    "injects a hub delivery and routes the native reply back to the sender (global %s, peer in %s)",
    async (global, toNamespace) => {
      const d = dir();
      const sock = join(d, "c.sock");
      const injected: Record<string, unknown>[] = [];
      const server = createServer((s) => {
        s.on("error", () => {}); // peer resets are not the test
        createInterface({ input: s }).on("line", (line) => {
          const f = JSON.parse(line) as Record<string, unknown>;
          if (f.type !== "user") return;
          injected.push(f);
          const back = connect(String(f.from).replace(/^uds:/, ""));
          back.on("connect", () =>
            back.end(
              `${JSON.stringify({
                msgV: 1,
                msg_id: "r1",
                type: "user",
                message: {
                  role: "user",
                  content: `<cross-session-message from="uds:${sock}" from-name="npm-test" from-mode="bypass">\npong\n</cross-session-message>`,
                },
                priority: "next",
                from: `uds:${sock}`,
              })}\n`,
            ),
          );
        });
      });
      servers.push(server);
      await new Promise<void>((r) => server.listen(sock, () => r()));
      writeSession(d, 4242, { messagingSocketPath: sock });
      const hash = createHash("sha256").update(sock).digest("hex");
      writeFileSync(
        join(d, `4242.${hash}.key`),
        JSON.stringify({ peerToken: "tok", procStart: "t0" }),
      );
      const h = await daemonHarness({
        claude: { ...syncDeps(d, new Set([4242])), statusWindowMs: 20 },
        resolveNamespace: () => ({ namespace: "own", global, source: "cwd" }),
      });
      await h.next("agent_up");
      h.toDaemon({
        ...deliverFrame("mmmmmmmmmmmmmmm1", "s4242"),
        namespace: toNamespace,
      });
      expect(await h.next("ack")).toMatchObject({ msg_id: "mmmmmmmmmmmmmmm1" });
      expect(injected[0]).toMatchObject({ msg_id: "mmmmmmmmmmmmmmm1" });
      const send = await h.next("send");
      expect(send).toMatchObject({
        from_ref: "s4242",
        to_name: "peer",
        body: "pong",
      });
      // Every reply names the peer's namespace, from the return path, so a same-named local peer cannot get it.
      expect(send.to_namespace).toBe(toNamespace);
    },
  );
});
