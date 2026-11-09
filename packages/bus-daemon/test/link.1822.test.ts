// #1822: `oa-bus mcp-proof` tells the daemon a proof hash for a Claude pid.
// Only a live Claude record the daemon attested for that pid takes it; the hub
// gets link_bind only when its hello_ok listed `link`, and again after a
// reconnect. Waits are signals (a frame arriving), never sleeps.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonLinkProof } from "@oa/bus-ipc";
import { BUS_CAPS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(async () => {
  await stopAll();
});

const HASH = "a".repeat(64);
const HASH2 = "b".repeat(64);

async function start(caps: string[], start = () => "t0") {
  const d = mkdtempSync(join(tmpdir(), "ob-link-"));
  writeFileSync(
    join(d, "4242.json"),
    JSON.stringify({
      pid: 4242,
      sessionId: "s-a",
      procStart: "t0",
      name: "open-artifacts-9e",
      messagingSocketPath: "",
      cwd: "/repo",
    }),
  );
  const h = await daemonHarness({
    claude: {
      sessionsDir: d,
      socketsDir: join(d, "r"),
      syncMs: 20,
      procStart: start,
      isRunning: () => true,
    },
  });
  const helloOk = () =>
    h.toDaemon({
      id: "w",
      type: "hello_ok",
      machine_id: "1".repeat(16),
      machine_label: "laptop",
      server_version: "1",
      caps,
    });
  const agentOk = (n: number) =>
    h.toDaemon({
      id: h.of("agent_up")[n - 1]?.id as string,
      type: "agent_ok",
      agent_ref: "s-a",
      bus_name: "open-artifacts-9e",
    });
  helloOk();
  await h.next("agent_up");
  agentOk(1);
  return { h, helloOk, agentOk };
}
const proof = (h: { socketPath: string }, pid: number, hash = HASH) =>
  daemonLinkProof({ path: h.socketPath, pid, hash });

describe("link_proof to link_bind (#1822)", () => {
  it("binds the hash to the live Claude record of that pid", async () => {
    const { h } = await start([BUS_CAPS.ids, BUS_CAPS.link]);
    expect(await proof(h, 4242)).toBe(true);
    const bind = await h.next("link_bind");
    expect(bind).toMatchObject({ agent_ref: "s-a", hash: HASH });
  });

  it("a pid with no live record binds nothing", async () => {
    const { h } = await start([BUS_CAPS.ids, BUS_CAPS.link]);
    expect(await proof(h, 9999)).toBe(false);
    // The same call for the real pid is answered after: nothing came before it.
    expect(await proof(h, 4242, HASH2)).toBe(true);
    await h.next("link_bind");
    expect(h.of("link_bind").map((f) => f.hash)).toEqual([HASH2]);
  });

  it("a pid whose start time moved (a reused pid) binds nothing", async () => {
    let now = "t0";
    const { h } = await start([BUS_CAPS.ids, BUS_CAPS.link], () => now);
    now = "t1";
    expect(await proof(h, 4242)).toBe(false);
    expect(h.of("link_bind")).toHaveLength(0);
  });

  it("sends nothing to a hub that did not list link", async () => {
    const { h } = await start([BUS_CAPS.ids]);
    expect(await proof(h, 4242)).toBe(true);
    expect(await proof(h, 9999)).toBe(false);
    expect(h.of("link_bind")).toHaveLength(0);
  });

  it("sends the current hash again after a reconnect", async () => {
    const { h, helloOk, agentOk } = await start([BUS_CAPS.ids, BUS_CAPS.link]);
    await proof(h, 4242, HASH);
    await proof(h, 4242, HASH2);
    await vi.waitFor(() => expect(h.of("link_bind")).toHaveLength(2));
    h.hubSock()?.close();
    await vi.waitFor(() => expect(h.of("agent_up").length).toBeGreaterThan(1));
    helloOk();
    agentOk(h.of("agent_up").length);
    await vi.waitFor(() => expect(h.of("link_bind")).toHaveLength(3));
    expect(h.of("link_bind")[2]).toMatchObject({
      agent_ref: "s-a",
      hash: HASH2,
    });
  });
});
