import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentVersion,
  installVersion,
  readPolicy,
  readReports,
  setPending,
  writeState,
} from "../src/index.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(async () => {
  await stopAll();
  delete process.env.OA_BUS_HOME;
});

/** A home on 1.0.0 whose daemon is the 1.1.0 folder, a switch pending. */
function switched() {
  const home = mkdtempSync(join(tmpdir(), "oa-ud-"));
  process.env.OA_BUS_HOME = home;
  const fill = (v: string) => (dir: string) => {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist/index.js"), `// ${v}\n`);
  };
  installVersion(home, "1.0.0", fill("1.0.0"));
  installVersion(home, "1.1.0", fill("1.1.0"));
  writeState(home, { armed: true, current: "1.0.0", previous: "1.0.0" });
  setPending(home, { from: "1.0.0", to: "1.1.0", startedAt: Date.now() });
  return { home, entry: join(home, "bin/dist/index.js") };
}

function seedClaudeSession(sessionsDir: string, pid: number) {
  const sessionId = `s${pid}`;
  writeFileSync(
    join(sessionsDir, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      procStart: "t0",
      name: "live-claude",
      messagingSocketPath: `/tmp/cc-socks/${pid}.sock`,
      cwd: "/repo",
    }),
  );
  return sessionId;
}

describe("update self-check with pre-existing live sessions (#3218)", () => {
  it("clears upIds from pre-open announceUp so self-check completes after agent_ok", async () => {
    const w = switched();
    const sessionsDir = mkdtempSync(join(tmpdir(), "ob-cs-3218-"));
    const seededRef = seedClaudeSession(sessionsDir, process.pid);
    const exit = vi.fn();
    const logs: string[] = [];
    let clock = 1_700_000_000_000;
    const ticks: (() => void)[] = [];
    const tick = () => {
      for (const fn of ticks) fn();
    };

    const h = await daemonHarness({
      log: (msg) => logs.push(msg),
      claude: {
        sessionsDir,
        procStart: (pid) => (pid === process.pid ? "t0" : null),
        isRunning: (pid) => pid === process.pid,
      },
      update: {
        defaultHome: true,
        entryFile: w.entry,
        exit,
        every: (fn) => {
          ticks.push(fn);
          return () => {};
        },
        now: () => clock,
        deadlineMs: 60_000,
      },
    });

    expect(readPolicy(w.home).pending).toBeDefined();

    const up = await h.next("agent_up");
    expect(up.agent_ref).toBe(seededRef);

    h.toDaemon({
      id: "w",
      type: "hello_ok",
      machine_id: "1".repeat(16),
      machine_label: "laptop",
      server_version: "1.1.0",
    });
    for (const f of h.of("agent_up")) {
      h.toDaemon({
        id: f.id,
        type: "agent_ok",
        agent_ref: f.agent_ref,
        bus_name: f.proposed_name,
      });
    }
    await h.quiet();

    clock += 1000;
    tick();

    expect(readPolicy(w.home).pending).toBeUndefined();
    expect(currentVersion(w.home)).toBe("1.1.0");
    expect(readReports(w.home)).toMatchObject([{ event: "updated" }]);
    expect(logs.some((m) => m.includes("updated to 1.1.0"))).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });

  it("completes self-check after hub link drops mid-check and reconnects", async () => {
    const w = switched();
    const sessionsDir = mkdtempSync(join(tmpdir(), "ob-cs-3218-"));
    const seededRef = seedClaudeSession(sessionsDir, process.pid);
    const exit = vi.fn();
    const logs: string[] = [];
    let clock = 1_700_000_000_000;
    const ticks: (() => void)[] = [];
    const tick = () => {
      for (const fn of ticks) fn();
    };

    const h = await daemonHarness({
      log: (msg) => logs.push(msg),
      claude: {
        sessionsDir,
        procStart: (pid) => (pid === process.pid ? "t0" : null),
        isRunning: (pid) => pid === process.pid,
      },
      update: {
        defaultHome: true,
        entryFile: w.entry,
        exit,
        every: (fn) => {
          ticks.push(fn);
          return () => {};
        },
        now: () => clock,
        deadlineMs: 60_000,
      },
    });

    const firstUp = await h.next("agent_up");
    expect(firstUp.agent_ref).toBe(seededRef);
    const upsBeforeDrop = h.of("agent_up").length;

    // Drop the hub link before agent_ok arrives.
    h.hubSock()?.close();

    // Daemon reconnects (harness backoff is 0) and re-announces live sessions.
    await h.next("hello", 2);
    const reUp = await h.next("agent_up", upsBeforeDrop + 1);
    expect(reUp.agent_ref).toBe(seededRef);

    h.toDaemon({
      id: "w2",
      type: "hello_ok",
      machine_id: "1".repeat(16),
      machine_label: "laptop",
      server_version: "1.1.0",
    });
    for (const f of h.of("agent_up").slice(upsBeforeDrop)) {
      h.toDaemon({
        id: f.id,
        type: "agent_ok",
        agent_ref: f.agent_ref,
        bus_name: f.proposed_name,
      });
    }
    await h.quiet();

    clock += 1000;
    tick();

    expect(readPolicy(w.home).pending).toBeUndefined();
    expect(currentVersion(w.home)).toBe("1.1.0");
    expect(logs.some((m) => m.includes("updated to 1.1.0"))).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });
});
