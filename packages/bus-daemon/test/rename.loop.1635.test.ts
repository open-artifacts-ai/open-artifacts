// The live loop (#1635): a headless `claude --resume` process shares a
// session's id, its file has no name, and the daemon flipped the session
// between "OA Contributions" and `claude-<otherpid>`, one rename per flip,
// until the hub's hourly cap answered rate_limited.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUS_CAPS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(async () => {
  vi.useRealTimers();
  await stopAll();
});

const write = (
  d: string,
  pid: number,
  sessionId: string,
  name: string | undefined,
) =>
  writeFileSync(
    join(d, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      procStart: `t${pid}`,
      ...(name === undefined ? {} : { name }),
      messagingSocketPath: "",
      cwd: "/repo",
    }),
  );

async function start() {
  const d = mkdtempSync(join(tmpdir(), "ob-rename-loop-"));
  write(d, 4242, "s-a", "OA Contributions");
  const h = await daemonHarness({
    claude: {
      sessionsDir: d,
      socketsDir: join(d, "r"),
      syncMs: 20,
      procStart: (pid: number) => `t${pid}`,
      isRunning: () => true,
    },
  });
  h.toDaemon({
    id: "w",
    type: "hello_ok",
    machine_id: "1".repeat(16),
    machine_label: "laptop",
    server_version: "1",
    caps: [BUS_CAPS.ids, BUS_CAPS.mailbox],
  });
  await vi.waitFor(() =>
    expect(h.of("agent_up").some((u) => u.agent_ref === "s-a")).toBe(true),
  );
  return { h, d };
}
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

describe("a session's unchanged name never loops renames (#1635)", () => {
  it("two live files with one sessionId, one nameless: no rename over many ticks", async () => {
    const { h, d } = await start();
    write(d, 5151, "s-a", undefined); // the headless process
    await settle();
    rmSync(join(d, "5151.json"));
    await settle(100);
    write(d, 5151, "s-a", undefined);
    await settle();
    expect(h.of("rename")).toHaveLength(0);
  });

  it("the other file is the one that has the name: still no flip", async () => {
    const { h, d } = await start();
    write(d, 4242, "s-a", undefined);
    write(d, 5151, "s-a", "OA Contributions");
    await settle();
    expect(h.of("rename")).toHaveLength(0);
  });

  it("a file read without its name for one tick is not a rename", async () => {
    const { h, d } = await start();
    write(d, 4242, "s-a", undefined);
    await settle();
    write(d, 4242, "s-a", "OA Contributions");
    await settle();
    expect(h.of("rename")).toHaveLength(0);
  });

  it("after rate_limited to a rename, no further frames for that ref within the hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { h, d } = await start();
    const names = ["A1", "A2", "A3", "A4", "A5", "A6"];
    for (const n of names) {
      write(d, 4242, "s-a", n);
      await settle(100);
      const last = h.of("rename").at(-1);
      if (last?.proposed_name === n)
        h.toDaemon({
          v: 1,
          id: last.id as string,
          type: "error",
          code: "rate_limited",
          message: "Too many renames",
        });
    }
    await settle(100);
    expect(h.of("rename")).toHaveLength(1);
    // An hour on, the latest name held back goes, with no new change.
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await vi.waitFor(() => expect(h.of("rename")).toHaveLength(2));
    expect(h.of("rename")[1]?.proposed_name).toBe("A6");
  });

  it("a suffixed bus name from the hub never repeats a rename across ticks or reconnects", async () => {
    const { h, d } = await start();
    h.toDaemon({
      v: 1,
      id: "ok0",
      type: "agent_ok",
      agent_ref: "s-a",
      bus_name: "OA Contributions-2",
    });
    write(d, 4242, "s-a", "OA Bus");
    await vi.waitFor(() => expect(h.of("rename")).toHaveLength(1));
    h.toDaemon({
      v: 1,
      id: h.of("rename")[0]?.id as string,
      type: "renamed",
      agent_ref: "s-a",
      bus_name: "OA Bus-2",
    });
    await settle();
    for (let i = 0; i < 2; i++) {
      const before = h.of("agent_up").length;
      h.hubSock()?.close();
      await vi.waitFor(() =>
        expect(h.of("agent_up").length).toBeGreaterThan(before),
      );
      h.toDaemon({
        id: `w${i}`,
        type: "hello_ok",
        machine_id: "1".repeat(16),
        machine_label: "laptop",
        server_version: "1",
        caps: [BUS_CAPS.ids, BUS_CAPS.mailbox],
      });
      h.toDaemon({
        v: 1,
        id: `ok${i + 1}`,
        type: "agent_ok",
        agent_ref: "s-a",
        bus_name: "OA Bus-2",
      });
      await settle();
    }
    expect(h.of("rename")).toHaveLength(1);
  });

  it("a real A to B to A rename reaches the hub", async () => {
    const { h, d } = await start();
    write(d, 4242, "s-a", "Other");
    await vi.waitFor(() => expect(h.of("rename")).toHaveLength(1));
    write(d, 4242, "s-a", "OA Contributions");
    await vi.waitFor(() => expect(h.of("rename")).toHaveLength(2));
    expect(h.of("rename")[1]?.proposed_name).toBe("OA Contributions");
  });

  it("a name flipping every tick sends at most 3 frames a minute, then the latest after the window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { h, d } = await start();
    for (let i = 0; i < 8; i++) {
      write(d, 4242, "s-a", i % 2 ? "Even" : `Odd${i}`);
      await settle(80);
    }
    expect(h.of("rename")).toHaveLength(3);
    write(d, 4242, "s-a", "Latest");
    await settle(100);
    expect(h.of("rename")).toHaveLength(3);
    vi.setSystemTime(Date.now() + 61_000);
    await vi.waitFor(() => expect(h.of("rename")).toHaveLength(4));
    expect(h.of("rename")[3]?.proposed_name).toBe("Latest");
  });

  it("a name the hub refused with rate_limited goes again after the hour, with no new change", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { h, d } = await start();
    write(d, 4242, "s-a", "OA Bus");
    await vi.waitFor(() => expect(h.of("rename")).toHaveLength(1));
    h.toDaemon({
      v: 1,
      id: h.of("rename")[0]?.id as string,
      type: "error",
      code: "rate_limited",
      message: "Too many renames",
    });
    await settle();
    expect(h.of("rename")).toHaveLength(1);
    vi.setSystemTime(Date.now() + 61 * 60_000);
    await vi.waitFor(() => expect(h.of("rename")).toHaveLength(2));
    expect(h.of("rename")[1]?.proposed_name).toBe("OA Bus");
  });

  it("one file per ref prefers the one with a socket; the membership list keeps every file", async () => {
    const { liveClaudeFiles, liveClaudeSessions } = await import(
      "../src/liveness/claude.ts"
    );
    const d = mkdtempSync(join(tmpdir(), "ob-rank-"));
    const file = (pid: number, extra: object) =>
      writeFileSync(
        join(d, `${pid}.json`),
        JSON.stringify({
          pid,
          sessionId: "s-z",
          procStart: `t${pid}`,
          name: "Named",
          cwd: "/repo",
          ...extra,
        }),
      );
    file(3000, {}); // headless: lower pid, no socket
    file(4242, { messagingSocketPath: "/tmp/x.sock" });
    const deps = {
      dir: d,
      procStart: (pid: number) => `t${pid}`,
      isRunning: () => true,
    };
    expect(liveClaudeSessions(deps).map((s) => s.pid)).toEqual([4242]);
    expect(
      liveClaudeFiles(deps)
        .map((s) => s.pid)
        .sort(),
    ).toEqual([3000, 4242]);
  });
});
