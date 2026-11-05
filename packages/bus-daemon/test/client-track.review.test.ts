// Whole-track review findings (client). Each test pins a failure the code
// still has; `it.fails` keeps the suite green until the fix lands, then flip
// it to `it`.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attest } from "../src/attest.ts";
import { home, socketPath } from "../src/config.ts";
import { liveClaudeSessions } from "../src/liveness/claude.ts";
import { ClaudeTransport } from "../src/transports/claude.ts";
import { daemonHarness, hello, stopAll } from "./helpers.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const servers: Server[] = [];
const transports: ClaudeTransport[] = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.close()));
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
  await stopAll();
});

/** A Claude inbox that records each injected user frame's msg_id. */
async function fakeClaude() {
  const d = tmp("ob-rv-");
  const sock = join(d, "claude.sock");
  const seen: string[] = [];
  const server = createServer((s) => {
    s.on("error", () => {});
    createInterface({ input: s }).on("line", (line) => {
      const f = JSON.parse(line) as Record<string, unknown>;
      if (f.type === "user") seen.push(String(f.msg_id));
    });
  });
  await new Promise<void>((r) => server.listen(sock, () => r()));
  servers.push(server);
  return { d, sock, seen };
}

const claudeAgent = {
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

describe("review: reconnect in the middle of a Claude delivery", () => {
  it("a daemon stopped inside the status window never injects the same message again after restart", async () => {
    const f = await fakeClaude();
    const heldFile = join(f.d, "held.json");
    const mk = (statusWindowMs: number) => {
      const t = new ClaudeTransport({
        socketsDir: join(tmp("ob-rvs-"), "r"),
        heldFile,
        statusWindowMs,
        target: () => ({ socketPath: f.sock, peerToken: "tok" }),
      });
      transports.push(t);
      return t;
    };
    const mail = {
      msg_id: "m1",
      from_name: "peer",
      namespace: "n",
      body: "hi",
    };
    const first = mk(5_000);
    const out = first.deliver(claudeAgent, mail);
    // Injected; the daemon stops (upgrade, launchd kickstart) before the window ends.
    await vi.waitFor(() => expect(f.seen).toEqual(["m1"]));
    await first.close();
    // Reported as a timeout: no ack, so the hub redelivers to the next daemon.
    expect(await out).toEqual({ ok: false, reason: "timeout" });
    await mk(40).deliver(claudeAgent, mail);
    expect(f.seen).toEqual(["m1"]);
  });
});

describe("review: the injected record", () => {
  it("is cleared once the status window ends, so a later redelivery injects again", async () => {
    const f = await fakeClaude();
    const heldFile = join(f.d, "held.json");
    const t = new ClaudeTransport({
      socketsDir: join(tmp("ob-rvs-"), "r"),
      heldFile,
      statusWindowMs: 40,
      target: () => ({ socketPath: f.sock, peerToken: "tok" }),
    });
    transports.push(t);
    const mail = {
      msg_id: "m2",
      from_name: "peer",
      namespace: "n",
      body: "hi",
    };
    expect(await t.deliver(claudeAgent, mail)).toEqual({ ok: true });
    expect(existsSync(join(f.d, "held.injected.json"))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(f.d, "held.injected.json"), "utf8")),
    ).toEqual({});
  });
});

describe("review: reconnect between a send and its receipt", () => {
  // Fixed in C16: the send is held and resent under its id (hub dedupe, B14);
  // at the tool call's timeout it answers Queued, never an error.
  it("a send written to the hub before the link dropped is not reported like one never sent", async () => {
    // The tool call's own clock: nothing times out until it is advanced.
    const due = new Map<() => void, number>();
    const h = await daemonHarness({
      hub: { backoffMs: () => 60_000 },
      pendingTimer: (ms, fn) => {
        due.set(fn, ms);
        return () => void due.delete(fn);
      },
    });
    const a = await h.adapter("A");
    await h.next("agent_up");
    // Never written: the hub is down.
    const r = a.request({ type: "send", id: "7", to: "bob", body: "hi" });
    // Written: the hub has it and may already have queued it for bob.
    await h.next("send");
    h.hubSock()?.terminate();
    await vi.waitFor(() => expect(h.daemon.hub.open).toBe(false));
    // The default Pending timeout, 10 s, runs out.
    expect([...due.values()]).toEqual([10_000]);
    for (const fn of [...due.keys()]) fn();
    const written = await r;
    const unsent = await a.request({
      type: "send",
      id: "8",
      to: "bob",
      body: "hi",
    });
    expect(unsent).toMatchObject({ type: "error", code: "hub_unavailable" });
    // Queued, as the agent reads any accepted send: nothing invites a retry.
    expect(written).toMatchObject({ type: "receipt", state: "pending" });
  });
});

describe("review: pid reuse", () => {
  it("an OpenCode session whose old service pid was reused can still be reached through the new service", async () => {
    const dir = tmp("ob-rvo-");
    writeFileSync(
      join(dir, "4321.json"),
      JSON.stringify({ pid: 4321, sessionIDs: ["ses_root"] }),
    );
    const alive = new Set([4321, 8001, 8002]);
    // After the crash, 8001 is some unrelated process.
    let reused = false;
    const h = await daemonHarness({
      attest: undefined,
      claude: { syncMs: 3_600_000 },
      opencode: {
        presenceDir: dir,
        spawn: async () => ({ code: 0, stdout: "", stderr: "" }),
        isRunning: (pid) => alive.has(pid),
        procStart: () => null,
        ancestors: (pid) => [pid, pid + 1000, 1],
        comm: (pid) =>
          pid === 8001 && reused
            ? "/usr/bin/node"
            : pid >= 8000
              ? "/usr/local/bin/opencode"
              : "node",
      },
    });
    const oc = (pid: number) => ({
      kind: "opencode" as const,
      pid,
      attest: { session_id: "ses_root" },
    });
    (await h.adapter("ses_root", oc(7001))).close();
    expect(h.daemon.agents.byRef("ses_root")?.pid).toBe(8001);
    // The service crashed and restarted as 8002; 8001 now runs something else.
    reused = true;
    const again = await h.adapter("ses_root", oc(7002));
    expect(again.welcome).toMatchObject({ type: "welcome" });
  });
});

describe("review: attestation agrees with liveness", () => {
  const dirWith = (file: object) => {
    const d = tmp("ob-rvc-");
    writeFileSync(join(d, "4242.json"), JSON.stringify(file));
    return d;
  };
  const base = {
    pid: 4242,
    sessionId: "6d3c1f0e-9a51-4c43-9a3e-2b0a4b8f1c11",
    procStart: "t0",
    cwd: "/repo",
  };
  for (const [what, extra] of [
    ["a parked job", { parkedJobId: "j" }],
    ["an agent-bus peer", { agentBus: true }],
  ] as const) {
    it(`never attests ${what} that liveness does not count as a session`, () => {
      const d = dirWith({ ...base, ...extra });
      // Liveness ignores it: the next sync tick would close what the hello opened.
      expect(
        liveClaudeSessions({
          dir: d,
          procStart: () => "t0",
          isRunning: () => true,
        }),
      ).toEqual([]);
      const r = attest(
        hello({ kind: "claude-code", agent_ref: base.sessionId, pid: 4242 }),
        { sessionsDir: d, ancestors: () => [4242], procStart: () => "t0" },
      );
      expect(r.ok).toBe(false);
    });
  }
});

describe("review: writes stay in OA_BUS_HOME", () => {
  it("an empty OA_BUS_HOME means the default home, as the CLI and adapters read it, never the cwd", () => {
    const prev = process.env.OA_BUS_HOME;
    process.env.OA_BUS_HOME = "";
    try {
      expect(isAbsolute(home())).toBe(true);
      expect(socketPath()).toBe(
        join(realpathSync.native(homedir()), ".oa-bus", "daemon.sock"),
      );
    } finally {
      if (prev === undefined) delete process.env.OA_BUS_HOME;
      else process.env.OA_BUS_HOME = prev;
    }
  });
});
