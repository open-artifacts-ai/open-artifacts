// open-bus #426 (2): a Claude reply to a return socket that went away with a
// daemon or session restart is routed by bus name, never lost to ENOENT.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeTransport } from "../src/transports/claude.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

const dir = () => mkdtempSync(join(tmpdir(), "ob-cr-"));
const agent = {
  ref: "s1",
  kind: "claude-code",
  proposedName: "a",
  busName: "a",
  namespace: "n",
  global: false,
  pid: 1,
  cwd: "/",
  live: true,
} as const;
const mail = (msg_id = "m1", from_name = "peer") => ({
  msg_id,
  from_name,
  namespace: "n",
  body: "hello",
});

const servers: Server[] = [];
const transports: ClaudeTransport[] = [];
afterEach(async () => {
  await stopAll();
  await Promise.all(transports.splice(0).map((t) => t.close()));
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

/** A Claude inbox at `sock`: records each injected frame's from= return socket. */
async function fakeClaude(sock: string) {
  const froms: string[] = [];
  const server = createServer((s) => {
    s.on("error", () => {});
    createInterface({ input: s }).on("line", (line) => {
      const f = JSON.parse(line) as Record<string, unknown>;
      if (f.type === "user") froms.push(String(f.from).replace(/^uds:/, ""));
    });
  });
  await new Promise<void>((r) => server.listen(sock, () => r()));
  servers.push(server);
  return froms;
}

function dial(to: string, frame: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = connect(to);
    s.once("error", reject);
    s.once("connect", () => s.end(`${JSON.stringify(frame)}\n`, resolve));
  });
}
const reply = (claudeSock: string, text: string) => ({
  msgV: 1,
  msg_id: "r1",
  type: "user",
  message: {
    role: "user",
    content: `<cross-session-message from="uds:${claudeSock}" hop-chain="c5" from-name="a" from-mode="bypass">\n${text}\n</cross-session-message>`,
  },
  priority: "next",
  from: `uds:${claudeSock}`,
});

type Reply = [string, string, string, string];
function transport(
  d: string,
  target: () => { socketPath: string; peerToken: string } | null,
  onReply: (...r: Reply) => void,
) {
  const t = new ClaudeTransport({
    socketsDir: join(d, "sinks"),
    returnIndexFile: join(d, "claude-return.json"),
    statusWindowMs: 20,
    target,
    onReply,
  });
  transports.push(t);
  return t;
}

describe("stale Claude return sockets (open-bus #426)", () => {
  it("a reply to a return socket from before a daemon restart reaches the peer by name", async () => {
    const d = dir();
    const claudeSock = join(d, "claude.sock");
    const froms = await fakeClaude(claudeSock);
    const target = () => ({ socketPath: claudeSock, peerToken: "tok" });
    const first = transport(d, target, () => {});
    expect(await first.deliver(agent, mail())).toEqual({ ok: true });
    const returnPath = froms[0] as string;
    // The daemon stops: its return sockets go with it.
    await first.close();
    transports.splice(transports.indexOf(first), 1);
    expect(existsSync(returnPath)).toBe(false);

    const replies: Reply[] = [];
    const second = transport(d, target, (...r) => replies.push(r));
    // The session is live again for the new daemon.
    await second.revive(agent.ref);
    await dial(returnPath, reply(claudeSock, "after the restart"));
    await vi.waitFor(() =>
      expect(replies).toEqual([["s1", "peer", "after the restart", "n"]]),
    );
  });

  it("a reply from the restarted session's new socket is believed", async () => {
    const d = dir();
    const oldSock = join(d, "claude-old.sock");
    const newSock = join(d, "claude-new.sock");
    const froms = await fakeClaude(oldSock);
    await fakeClaude(newSock);
    let current = oldSock;
    const replies: Reply[] = [];
    const t = transport(
      d,
      () => ({ socketPath: current, peerToken: "tok" }),
      (...r) => replies.push(r),
    );
    expect(await t.deliver(agent, mail())).toEqual({ ok: true });
    const returnPath = froms[0] as string;
    // `claude --resume`: the session closes, then comes back on a new socket.
    await t.drop(agent.ref);
    current = newSock;
    await t.revive(agent.ref);
    await dial(returnPath, reply(newSock, "from the resumed session"));
    await vi.waitFor(() =>
      expect(replies).toEqual([
        ["s1", "peer", "from the resumed session", "n"],
      ]),
    );
  });

  it("still believes only the session itself", async () => {
    const d = dir();
    const claudeSock = join(d, "claude.sock");
    const froms = await fakeClaude(claudeSock);
    const replies: Reply[] = [];
    const t = transport(
      d,
      () => ({ socketPath: claudeSock, peerToken: "tok" }),
      (...r) => replies.push(r),
    );
    await t.deliver(agent, mail());
    await t.drop(agent.ref);
    await t.revive(agent.ref);
    await dial(froms[0] as string, reply(join(d, "someone-else.sock"), "x"));
    await new Promise((r) => setTimeout(r, 50));
    expect(replies).toEqual([]);
  });

  it("revives only that session's sockets, each peer on its own", async () => {
    const d = dir();
    const claudeSock = join(d, "claude.sock");
    const froms = await fakeClaude(claudeSock);
    const target = () => ({ socketPath: claudeSock, peerToken: "tok" });
    const first = transport(d, target, () => {});
    await first.deliver(agent, mail("m1", "alice"));
    await first.deliver(agent, mail("m2", "bob"));
    await first.deliver({ ...agent, ref: "s2" }, mail("m3", "carol"));
    await first.close();
    transports.splice(transports.indexOf(first), 1);
    const replies: Reply[] = [];
    const second = transport(d, target, (...r) => replies.push(r));
    await second.revive("s1");
    const [alice, bob, carol] = froms as [string, string, string];
    expect(existsSync(alice)).toBe(true);
    expect(existsSync(bob)).toBe(true);
    expect(existsSync(carol)).toBe(false);
    await dial(bob, reply(claudeSock, "to bob"));
    await vi.waitFor(() =>
      expect(replies).toEqual([["s1", "bob", "to bob", "n"]]),
    );
  });
});

describe("the daemon revives a live session's return sockets", () => {
  it("binds them again, from the index, when it announces the session", async () => {
    const d = dir();
    const sessions = join(d, "sessions");
    const sinks = join(d, "sinks");
    const index = join(d, "claude-return.json");
    const key = "s4242\u0000ns\u0000peer";
    // What a daemon before this one recorded.
    writeFileSync(
      index,
      JSON.stringify({
        [key]: { agentRef: "s4242", namespace: "ns", peerName: "peer", at: 1 },
      }),
      { mode: 0o600 },
    );
    mkdirSync(sessions);
    writeFileSync(
      join(sessions, "4242.json"),
      JSON.stringify({
        pid: 4242,
        sessionId: "s4242",
        procStart: "t0",
        name: "npm-test",
        messagingSocketPath: join(d, "claude.sock"),
        cwd: "/repo",
      }),
    );
    const name = createHash("sha256").update(key).digest("hex").slice(0, 8);
    const h = await daemonHarness({
      claude: {
        sessionsDir: sessions,
        socketsDir: sinks,
        returnIndexFile: index,
        syncMs: 20,
        procStart: () => "t0",
        isRunning: (pid) => pid === 4242,
      },
    });
    await h.next("agent_up");
    await vi.waitFor(() =>
      expect(existsSync(join(sinks, `${name}.sock`))).toBe(true),
    );
  });
});
