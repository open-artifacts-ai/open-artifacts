import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { busHome } from "@oa/bus-adapter-claude-code";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isDefaultHome } from "../src/config.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

const writeSession = (d: string, pid: number) =>
  writeFileSync(
    join(d, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: `s${pid}`,
      procStart: "t0",
      name: "npm-test",
      messagingSocketPath: `/tmp/cc-socks/${pid}.sock`,
      cwd: "/repo",
    }),
  );

// One sessions dir shared by every bus on the machine, as ~/.claude/sessions is.
const shared = (running: Set<number>) => {
  const d = mkdtempSync(join(tmpdir(), "ob-2806-"));
  return {
    d,
    deps: {
      sessionsDir: d,
      socketsDir: join(d, "sinks"),
      syncMs: 20,
      procStart: (pid: number) => (running.has(pid) ? "t0" : null),
      isRunning: (pid: number) => running.has(pid),
    },
  };
};
/** Several sync ticks: an announcement would have gone by now. */
const ticks = () => new Promise((r) => setTimeout(r, 150));

describe("a second bus home claims only its own Claude sessions (#2806)", () => {
  it("decides the default home from the resolved path alone", () => {
    expect(isDefaultHome(busHome({}))).toBe(true);
    expect(isDefaultHome(join(tmpdir(), ".oa-bus-other"))).toBe(false);
  });

  it("two daemons, one sessions dir: the second home announces nothing it only scanned", async () => {
    const running = new Set([4242]);
    const { d, deps } = shared(running);
    writeSession(d, 4242);
    const main = await daemonHarness({ claude: { ...deps, discover: true } });
    const second = await daemonHarness({
      claude: { ...deps, discover: false },
    });
    expect(await main.next("agent_up")).toMatchObject({ agent_ref: "s4242" });
    await ticks();
    expect(second.of("agent_up")).toEqual([]);
    expect(second.daemon.agents.byRef("s4242")).toBeUndefined();
  });

  it("the second home keeps a session its own adapter said hello for, and the scan still tracks it", async () => {
    const running = new Set([4242]);
    const { d, deps } = shared(running);
    writeSession(d, 4242);
    const second = await daemonHarness({
      claude: { ...deps, discover: false },
    });
    await second.adapter("s4242", { kind: "claude-code", pid: 4242 });
    expect(await second.next("agent_up")).toMatchObject({
      agent_ref: "s4242",
    });
    running.delete(4242);
    await vi.waitFor(() =>
      expect(second.daemon.agents.byRef("s4242")?.live).toBe(false),
    );
  });

  it("the default home leaves a session started for another home alone", async () => {
    const running = new Set([4242, 4343]);
    const { d, deps } = shared(running);
    writeSession(d, 4242);
    writeSession(d, 4343);
    const main = await daemonHarness({
      claude: {
        ...deps,
        discover: true,
        homeOf: (pid: number) =>
          pid === 4343 ? join(tmpdir(), ".oa-bus-other") : undefined,
      },
    });
    expect(await main.next("agent_up")).toMatchObject({ agent_ref: "s4242" });
    await ticks();
    expect(main.of("agent_up").map((f) => f.agent_ref)).toEqual(["s4242"]);
  });
});
