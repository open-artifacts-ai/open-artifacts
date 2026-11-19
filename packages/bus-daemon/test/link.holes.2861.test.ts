// #2861: three ways a Claude session's saved proof hashes were lost.
// F1: a hello whose session-file lookup misses dropped the record's procStart.
// F2: saved hashes were only seeded at creation, never once procStart was known.
// F3: a record closed by one missed read left claude-links.json while its
// process still ran. Waits are signals (a frame, a state), never sleeps.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonLinkProof } from "@oa/bus-ipc";
import { BUS_CAPS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(async () => {
  await stopAll();
});

const X = "c".repeat(64);
const body = (pid: number, ref: string) =>
  JSON.stringify({
    pid,
    sessionId: ref,
    procStart: "t0",
    name: "open-artifacts-9e",
    messagingSocketPath: "",
    cwd: "/repo",
  });
const hello = (h: Awaited<ReturnType<typeof daemonHarness>>) =>
  h.toDaemon({
    id: "w",
    type: "hello_ok",
    machine_id: "1".repeat(16),
    machine_label: "laptop",
    server_version: "1",
    caps: [BUS_CAPS.ids, BUS_CAPS.link],
  });
const agentOk = (h: Awaited<ReturnType<typeof daemonHarness>>, ref: string) =>
  h.toDaemon({
    id: h.of("agent_up").filter((f) => f.agent_ref === ref)[0]?.id as string,
    type: "agent_ok",
    agent_ref: ref,
    bus_name: "n",
  });
const boot = async (d: string, linksFile: string) => {
  const h = await daemonHarness({
    claude: {
      sessionsDir: d,
      socketsDir: join(d, "r"),
      syncMs: 20,
      procStart: () => "t0",
      isRunning: () => true,
      linksFile,
    },
  });
  hello(h);
  return h;
};
const links = (f: string) => JSON.parse(readFileSync(f, "utf8")).links;
const dirs = () => ({
  d: mkdtempSync(join(tmpdir(), "ob-h2861-")),
  linksFile: join(mkdtempSync(join(tmpdir(), "ob-h2861h-")), "l.json"),
});

describe("saved proof hashes are not lost (#2861)", () => {
  it("T5 (F1): a hello whose file lookup misses keeps the start time, so the hashes stay saved", async () => {
    const { d, linksFile } = dirs();
    writeFileSync(join(d, "4242.json"), body(4242, "s-a"));
    const h = await boot(d, linksFile);
    await h.next("agent_up");
    agentOk(h, "s-a");
    await daemonLinkProof({ path: h.socketPath, pid: 4242, hash: X });
    await vi.waitFor(() => expect(h.of("link_bind")).toHaveLength(1));
    // One missed read closes the record; the file is then unreadable for a
    // moment (a rewrite) when the hello reopens it, so its lookup misses.
    rmSync(join(d, "4242.json"));
    await vi.waitFor(() =>
      expect(h.daemon.agents.byRef("s-a")?.live).toBe(false),
    );
    writeFileSync(join(d, "4242.json"), "{");
    await h.adapter("s-a", { kind: "claude-code", pid: 4242, cwd: "/repo" });
    expect(h.daemon.agents.byRef("s-a")?.procStart).toBe("t0");
    // A later session appearing proves a sync tick ran after the hello.
    writeFileSync(join(d, "5555.json"), body(5555, "s-b"));
    await vi.waitFor(() =>
      expect(h.of("agent_up").map((f) => f.agent_ref)).toContain("s-b"),
    );
    expect(links(linksFile)).toEqual([
      { pid: 4242, procStart: "t0", hashes: [X] },
    ]);
  });

  it("T6 (F2): a hello first, an unreadable file, then the file: the saved hash binds", async () => {
    const { d, linksFile } = dirs();
    writeFileSync(
      linksFile,
      JSON.stringify({
        v: 1,
        links: [{ pid: 4242, procStart: "t0", hashes: [X] }],
      }),
      { mode: 0o600 },
    );
    writeFileSync(join(d, "4242.json"), "{");
    const h = await boot(d, linksFile);
    await h.adapter("s-a", { kind: "claude-code", pid: 4242, cwd: "/repo" });
    await h.next("agent_up");
    agentOk(h, "s-a");
    expect(h.of("link_bind")).toHaveLength(0);
    writeFileSync(join(d, "4242.json"), body(4242, "s-a"));
    await vi.waitFor(() =>
      expect(
        h.of("link_bind").some((f) => f.agent_ref === "s-a" && f.hash === X),
      ).toBe(true),
    );
  });

  it("T7 (F3): a liveness close while the process runs keeps the hash for the next daemon", async () => {
    const { d, linksFile } = dirs();
    writeFileSync(join(d, "4242.json"), body(4242, "s-a"));
    const one = await boot(d, linksFile);
    await one.next("agent_up");
    agentOk(one, "s-a");
    await daemonLinkProof({ path: one.socketPath, pid: 4242, hash: X });
    await vi.waitFor(() => expect(one.of("link_bind")).toHaveLength(1));
    rmSync(join(d, "4242.json"));
    await vi.waitFor(() =>
      expect(one.daemon.agents.byRef("s-a")?.live).toBe(false),
    );
    expect(links(linksFile)).toEqual([
      { pid: 4242, procStart: "t0", hashes: [X] },
    ]);
    await one.daemon.stop();
    writeFileSync(join(d, "4242.json"), body(4242, "s-a"));
    const two = await boot(d, linksFile);
    await two.next("agent_up");
    agentOk(two, "s-a");
    await vi.waitFor(() =>
      expect(two.of("link_bind").map((f) => f.hash)).toEqual([X]),
    );
  });
});
