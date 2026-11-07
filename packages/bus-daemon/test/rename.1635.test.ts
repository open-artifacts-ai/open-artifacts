// A Claude `/rename` after connect (#1635): the session file's name changes
// and the daemon sends one `rename`; the hub's answer is never a new change.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUS_CAPS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(async () => {
  vi.useRealTimers();
  await stopAll();
});

const write = (d: string, pid: number, sessionId: string, name: string) =>
  writeFileSync(
    join(d, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      procStart: "t0",
      name,
      messagingSocketPath: "",
      cwd: "/repo",
    }),
  );

async function start(fakeTick = false) {
  const d = mkdtempSync(join(tmpdir(), "ob-rename-"));
  write(d, 4242, "s-a", "open-artifacts-9e");
  const h = await daemonHarness({
    claude: {
      sessionsDir: d,
      socketsDir: join(d, "r"),
      syncMs: 20,
      procStart: () => "t0",
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
  // The first tick announces s-a; with a faked interval, run it by hand.
  if (fakeTick) await vi.advanceTimersByTimeAsync(100);
  await vi.waitFor(() =>
    expect(h.of("agent_up").some((u) => u.agent_ref === "s-a")).toBe(true),
  );
  return { h, d };
}
const settle = () => new Promise((r) => setTimeout(r, 150));

describe("session rename after connect (#1635)", () => {
  it("sends one rename when the file name changes, and none when it does not", async () => {
    const { h, d } = await start();
    await settle();
    expect(h.of("rename")).toHaveLength(0);
    write(d, 4242, "s-a", "OA Bus");
    await vi.waitFor(() => expect(h.of("rename")).toHaveLength(1));
    const r = h.of("rename")[0];
    expect(r).toMatchObject({
      agent_ref: "s-a",
      proposed_name: "OA Bus",
      name_kind: "chosen",
    });
    h.toDaemon({
      v: 1,
      id: r?.id as string,
      type: "renamed",
      agent_ref: "s-a",
      bus_name: "OA-Bus-2",
    });
    await settle();
    expect(h.of("rename")).toHaveLength(1);
  });

  it("a refusal is logged, not retried, and a later change goes again", async () => {
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
    write(d, 4242, "s-a", "OA Bus 2");
    await vi.waitFor(() => expect(h.of("rename")).toHaveLength(2));
    expect(h.of("rename")[1]?.proposed_name).toBe("OA Bus 2");
  });

  it("a /clear (new ref, same pid) is a handover, not a rename", async () => {
    const { h, d } = await start();
    write(d, 4242, "s-b", "open-artifacts-9e");
    await vi.waitFor(() =>
      expect(h.of("agent_up").some((u) => u.agent_ref === "s-b")).toBe(true),
    );
    await settle();
    expect(h.of("rename")).toHaveLength(0);
  });

  it("a hello that beats the tick after a /clear sets the name: no rename", async () => {
    // Only the sync interval is faked: a tick runs when the test says so.
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const { h, d } = await start(true);
    write(d, 4242, "s-b", "open-artifacts-9e");
    await h.adapter("s-b", {
      kind: "claude-code",
      cwd: "/repo",
      pid: 4242,
      proposed_name: "open-artifacts-9e",
    });
    // Now the first tick sees the new file for an agent the hello made.
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.of("rename")).toHaveLength(0);
  });

  it("a rename noted while a handover agent_up waits goes on its agent_ok", async () => {
    const { h, d } = await start();
    write(d, 4242, "s-b", "open-artifacts-9e");
    await vi.waitFor(() =>
      expect(h.of("agent_up").some((u) => u.agent_ref === "s-b")).toBe(true),
    );
    write(d, 4242, "s-b", "OA Bus");
    await settle();
    expect(h.of("rename")).toHaveLength(0);
    h.toDaemon({
      v: 1,
      id: "ok1",
      type: "agent_ok",
      agent_ref: "s-b",
      bus_name: "open-artifacts-9e",
    });
    await vi.waitFor(() => expect(h.of("rename")).toHaveLength(1));
    expect(h.of("rename")[0]).toMatchObject({
      agent_ref: "s-b",
      proposed_name: "OA Bus",
    });
  });

  it("an empty name or the claude-<pid> fallback is not a rename", async () => {
    const { h, d } = await start();
    write(d, 4242, "s-a", "");
    await settle();
    write(d, 4242, "s-a", "claude-4242");
    await settle();
    expect(h.of("rename")).toHaveLength(0);
    write(d, 4242, "s-a", "OA Bus");
    await vi.waitFor(() => expect(h.of("rename")).toHaveLength(1));
    expect(h.of("rename")[0]?.proposed_name).toBe("OA Bus");
  });

  it("a rename noted before hello_ok goes once hello_ok arrives", async () => {
    const { h, d } = await start();
    const before = h.of("agent_up").length;
    h.hubSock()?.close();
    await vi.waitFor(() =>
      expect(h.of("agent_up").length).toBeGreaterThan(before),
    );
    write(d, 4242, "s-a", "OA Bus");
    await settle();
    expect(h.of("rename")).toHaveLength(0);
    h.toDaemon({
      id: "w2",
      type: "hello_ok",
      machine_id: "1".repeat(16),
      machine_label: "laptop",
      server_version: "1",
      caps: [BUS_CAPS.ids, BUS_CAPS.mailbox],
    });
    await vi.waitFor(() => expect(h.of("rename")).toHaveLength(1));
    expect(h.of("rename")[0]?.proposed_name).toBe("OA Bus");
  });
});
