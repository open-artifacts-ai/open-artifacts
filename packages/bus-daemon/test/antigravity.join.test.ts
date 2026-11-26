// agy S2: an Antigravity (agy) conversation joins at its first message. The
// hook says hello once and closes; the record lives as long as the agy
// process, follows a /clear, and is homed by the folder map. The S1a attest
// runs for real over a fake process table: no real agy runs.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgyConversation,
  agyHello,
  callTool,
  readAgyConversation,
  writeAgyConversation,
} from "@oa/bus-adapter-claude-code";
import { connectDaemon, HelloRefused } from "@oa/bus-ipc";
import { BUS_CAPS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attest } from "../src/attest.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

const A = "0b7e6a9c-1f2d-4c3b-9a8e-7d6c5b4a3f21";
const B = "5d1c9e2a-3b4f-4a6d-8e7f-0a1b2c3d4e5f";
const AGY = 4242;

/** The OS as the daemon sees it: which pids run, what, and since when. */
const os = {
  alive: new Set<number>(),
  comm: new Map<number, string>(),
  start: new Map<number, string>(),
};

const byFolder = (cwd: string) =>
  cwd.startsWith("/u/")
    ? { unmapped: true as const }
    : { instance: "main" as const };

async function setup() {
  os.alive = new Set([AGY]);
  os.comm = new Map([[AGY, "/Users/u/.local/bin/agy"]]);
  os.start = new Map([[AGY, "t0"]]);
  const h = await daemonHarness({
    homeLookup: byFolder,
    // S1a's attest, on the fake table: binary and start time.
    attest: (hello) =>
      attest(hello, {
        comm: (pid) => os.comm.get(pid) ?? null,
        procStart: (pid) => os.start.get(pid) ?? null,
      }),
    antigravity: {
      isRunning: (pid) => os.alive.has(pid),
      procStart: (pid) => os.start.get(pid) ?? null,
    },
    claude: { syncMs: 20 },
  });
  h.toDaemon({
    id: "w",
    type: "hello_ok",
    machine_id: "1".repeat(16),
    machine_label: "laptop",
    server_version: "1",
    caps: [BUS_CAPS.ids, BUS_CAPS.mailbox],
  });
  /** What the hook does: says hello for the conversation, then closes. */
  const hook = async (c: Partial<AgyConversation> = {}) => {
    const hello = agyHello({
      pid: AGY,
      procStart: "t0",
      conversationId: A,
      cwd: "/w/app",
      ...c,
    });
    if (!hello) throw new Error("no hello");
    const client = await connectDaemon({ path: h.socketPath, hello });
    client.close();
    return client.welcome;
  };
  return { h, hook };
}

type H = Awaited<ReturnType<typeof setup>>["h"];
const upFor = async (h: H, ref: string) => {
  await vi.waitFor(() =>
    expect(h.of("agent_up").some((u) => u.agent_ref === ref)).toBe(true),
  );
  return h.of("agent_up").find((u) => u.agent_ref === ref);
};
const closedRef = (h: H, ref: string) =>
  vi.waitFor(() =>
    expect(h.of("sessions").some((f) => f.closed.includes(ref))).toBe(true),
  );

describe("an agy conversation on the bus (agy S2)", () => {
  it("joins from the hook's hello as kind antigravity, for the agy pid, and stays after the hook exits", async () => {
    const { h, hook } = await setup();
    const welcome = await hook();
    expect(welcome.bus_name).toBe("agy");
    expect(await upFor(h, A)).toMatchObject({
      agent_ref: A,
      kind: "antigravity",
      proposed_name: "agy",
    });
    const rec = h.daemon.agents.byRef(A);
    expect(rec).toMatchObject({
      kind: "antigravity",
      pid: AGY,
      cwd: "/w/app",
      live: true,
      instance: "main",
      procStart: "t0",
    });
    // The MCP server's later hello for the same conversation is the same record.
    const again = await hook();
    expect(again.bus_name).toBe("agy");
    expect(h.daemon.agents.byRef(A)?.live).toBe(true);
    expect(h.of("sessions").some((f) => f.closed.includes(A))).toBe(false);
  });

  it("is refused for a pid that does not run agy, or started at another time", async () => {
    const { hook } = await setup();
    os.comm.set(AGY, "/bin/zsh");
    await expect(hook()).rejects.toThrow(/does not run agy/);
    os.comm.set(AGY, "/Users/u/.local/bin/agy");
    await expect(hook({ procStart: "t-other" })).rejects.toBeInstanceOf(
      HelloRefused,
    );
  });

  it("closes when the agy process ends", async () => {
    const { h, hook } = await setup();
    await hook();
    await upFor(h, A);
    os.alive.delete(AGY);
    await closedRef(h, A);
    expect(h.daemon.agents.byRef(A)?.live).toBe(false);
  });

  it("closes when the pid now runs a process started at another time", async () => {
    const { h, hook } = await setup();
    await hook();
    await upFor(h, A);
    os.start.set(AGY, "t1");
    await closedRef(h, A);
  });

  it("a /clear in the same agy: the new conversation takes the address, the old one closes", async () => {
    const { h, hook } = await setup();
    await hook();
    await upFor(h, A);
    const w = await hook({ conversationId: B });
    expect(w.bus_name).toBe("agy");
    expect(await upFor(h, B)).toMatchObject({
      agent_ref: B,
      replaces: A,
      proposed_name: "agy",
    });
    await closedRef(h, A);
    expect(h.daemon.agents.byRef(A)?.live).toBe(false);
    expect(h.daemon.agents.byRef(B)?.live).toBe(true);
  });

  it("another agy process is another agent", async () => {
    const { h, hook } = await setup();
    await hook();
    await upFor(h, A);
    os.alive.add(5555);
    os.comm.set(5555, "agy");
    os.start.set(5555, "t5");
    await hook({ pid: 5555, procStart: "t5", conversationId: B });
    const up = await upFor(h, B);
    expect(up).not.toHaveProperty("replaces");
    expect(h.daemon.agents.byRef(A)?.live).toBe(true);
  });

  it("an unmapped folder sits on no hub", async () => {
    const { h, hook } = await setup();
    await hook({ cwd: "/u/elsewhere" });
    await hook({ pid: AGY, conversationId: B, cwd: "/w/app" });
    await upFor(h, B);
    expect(h.of("agent_up").map((u) => u.agent_ref)).toEqual([B]);
  });

  it("the bus tools speak for the conversation the hook recorded", async () => {
    const { h, hook } = await setup();
    const home = mkdtempSync(join(tmpdir(), "ob-agyh-"));
    const conv = {
      pid: AGY,
      procStart: "t0",
      conversationId: A,
      cwd: "/w/app",
    };
    writeAgyConversation(home, conv);
    await hook();
    await upFor(h, A);
    // What `oa-bus mcp antigravity` does per call: the record, a hello, the tool.
    const rec = readAgyConversation(home, AGY) as AgyConversation;
    const client = await connectDaemon({
      path: h.socketPath,
      hello: agyHello(rec) as NonNullable<ReturnType<typeof agyHello>>,
    });
    const r = await callTool("self", {}, client);
    client.close();
    expect(r.isError).toBeFalsy();
    expect(JSON.stringify(r.content)).toContain("agy");
    expect(h.daemon.agents.byRef(A)?.live).toBe(true);
  });
});
