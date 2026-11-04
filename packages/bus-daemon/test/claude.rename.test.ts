// open-bus #426 (1) and #393: a Claude session's bus name follows its
// `/rename`, and a restarted session keeps the name it had.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonHarness, stopAll } from "./helpers.ts";

const dir = () => mkdtempSync(join(tmpdir(), "ob-rn-"));
afterEach(stopAll);

/** A session file; `name` undefined writes none, as Claude does before a /rename. */
const writeSession = (
  d: string,
  pid: number,
  name: string | undefined,
  over: object = {},
) =>
  writeFileSync(
    join(d, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: "s1",
      procStart: "t0",
      ...(name === undefined ? {} : { name }),
      messagingSocketPath: `/tmp/cc-socks/${pid}.sock`,
      cwd: "/repo",
      ...over,
    }),
  );

const syncDeps = (d: string, running: Set<number>) => ({
  sessionsDir: d,
  socketsDir: join(d, "sinks"),
  syncMs: 20,
  procStart: (pid: number) => (running.has(pid) ? "t0" : null),
  isRunning: (pid: number) => running.has(pid),
});

describe("a Claude session's name (open-bus #426, #393)", () => {
  it("a /rename after the session started is proposed to the hub", async () => {
    const d = dir();
    writeSession(d, 4242, undefined);
    const h = await daemonHarness({ claude: syncDeps(d, new Set([4242])) });
    expect(await h.next("agent_up")).toMatchObject({
      agent_ref: "s1",
      proposed_name: "claude-4242",
    });
    writeSession(d, 4242, "OB Manager");
    expect(await h.next("agent_up", 2)).toMatchObject({
      agent_ref: "s1",
      proposed_name: "OB Manager",
    });
    expect(h.daemon.agents.byRef("s1")?.proposedName).toBe("OB Manager");
    // Once: an unchanged file proposes nothing more.
    await new Promise((r) => setTimeout(r, 100));
    expect(h.of("agent_up")).toHaveLength(2);
  });

  it("a restarted session whose file has no name yet keeps its name", async () => {
    const d = dir();
    writeSession(d, 4242, "OB Manager");
    const running = new Set([4242]);
    const h = await daemonHarness({ claude: syncDeps(d, running) });
    expect(await h.next("agent_up")).toMatchObject({
      proposed_name: "OB Manager",
    });
    // The session stops, then `claude --resume` brings it back on a new pid,
    // and its new session file names it only later.
    running.delete(4242);
    await vi.waitFor(() =>
      expect(h.daemon.agents.byRef("s1")?.live).toBe(false),
    );
    rmSync(join(d, "4242.json"));
    writeSession(d, 5151, undefined);
    running.add(5151);
    expect(await h.next("agent_up", 2)).toMatchObject({
      agent_ref: "s1",
      proposed_name: "OB Manager",
    });
    // Its file then names it again: nothing changes.
    writeSession(d, 5151, "OB Manager");
    await new Promise((r) => setTimeout(r, 100));
    expect(h.of("agent_up")).toHaveLength(2);
  });

  it("a restarted session's MCP hello with a generated name keeps the real one", async () => {
    const d = dir();
    writeSession(d, 4242, "OB Manager");
    const running = new Set([4242]);
    let pid = 4242;
    const h = await daemonHarness({
      claude: { ...syncDeps(d, running), syncMs: 60_000 },
      attest: () => ({ ok: true, cwd: "/repo", pid }),
    });
    await h.next("agent_up");
    const a = await h.adapter("s1", { pid: 9999, proposed_name: "OB Manager" });
    a.close();
    // The session restarts; the daemon learns it closed before the new hello.
    running.delete(4242);
    const rec = h.daemon.agents.byRef("s1");
    if (rec) rec.live = false;
    rmSync(join(d, "4242.json"));
    writeSession(d, 5151, undefined);
    running.add(5151);
    pid = 5151;
    await h.adapter("s1", { pid: 9998, proposed_name: "claude-5151" });
    expect(await h.next("agent_up", 2)).toMatchObject({
      agent_ref: "s1",
      proposed_name: "OB Manager",
    });
  });

  it("the generated name of a new pid never replaces a real one", async () => {
    const d = dir();
    writeSession(d, 4242, "OB Manager");
    const running = new Set([4242, 5151]);
    const h = await daemonHarness({ claude: syncDeps(d, running) });
    await h.next("agent_up");
    // `claude --resume` while the old process still runs: a second file, no name.
    writeSession(d, 5151, undefined);
    running.delete(4242);
    rmSync(join(d, "4242.json"));
    await vi.waitFor(() => expect(h.daemon.agents.byRef("s1")?.pid).toBe(5151));
    await new Promise((r) => setTimeout(r, 100));
    expect(h.of("agent_up").map((f) => f.proposed_name)).not.toContain(
      "claude-5151",
    );
    expect(h.daemon.agents.byRef("s1")?.proposedName).toBe("OB Manager");
  });
});
