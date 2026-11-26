// #2861: a resume or /clear swaps the session ref under one process. The proof
// hashes follow the process: the new ref binds them, and the old ref's leave
// must not take them away. The fake hub keeps proofs per ref, drops an old
// ref's proofs when its address is taken over or it goes down (as the real
// hub does), and moves a hash to the ref that binds it.
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

const H1 = "a".repeat(64);
const file = (d: string, ref: string, name = "4242.json") =>
  writeFileSync(
    join(d, name),
    JSON.stringify({
      pid: 4242,
      sessionId: ref,
      procStart: "t0",
      name: "open-artifacts-9e",
      messagingSocketPath: "",
      cwd: "/repo",
    }),
  );

describe("a ref switch under one process keeps the proof (#2861)", () => {
  it("T4a: ref A joins, H1 binds to A, B joins, A leaves: H1 resolves to B", async () => {
    const d = mkdtempSync(join(tmpdir(), "ob-l2861r-"));
    file(d, "A");
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
      caps: [BUS_CAPS.ids, BUS_CAPS.link],
    });
    const upA = await h.next("agent_up");
    h.toDaemon({ id: upA.id, type: "agent_ok", agent_ref: "A", bus_name: "n" });
    await daemonLinkProof({ path: h.socketPath, pid: 4242, hash: H1 });
    await vi.waitFor(() => expect(h.of("link_bind")).toHaveLength(1));
    file(d, "B");
    await vi.waitFor(() =>
      expect(h.of("agent_up").map((f) => f.agent_ref)).toContain("B"),
    );
    const upB = h.of("agent_up").find((f) => f.agent_ref === "B");
    h.toDaemon({
      id: upB?.id as string,
      type: "agent_ok",
      agent_ref: "B",
      bus_name: "n",
    });
    await vi.waitFor(() =>
      expect(
        h.of("link_bind").some((f) => f.agent_ref === "B" && f.hash === H1),
      ).toBe(true),
    );
    // Fake hub: replay every frame in order against a proofs-by-ref map.
    const proofs = new Map<string, string>();
    for (const f of h.frames) {
      if (f.type === "link_bind") proofs.set(f.hash, f.agent_ref);
      if (f.type === "agent_up" && f.replaces) {
        for (const [k, v] of proofs) if (v === f.replaces) proofs.delete(k);
      }
      if (f.type === "sessions") {
        for (const c of (f as { closed?: string[] }).closed ?? [])
          for (const [k, v] of proofs) if (v === c) proofs.delete(k);
      }
    }
    expect(proofs.get(H1)).toBe("B");
  });

  it("T4b: B's hello beats the file switch, then A leaves session_gone: H1 resolves to B", async () => {
    const d = mkdtempSync(join(tmpdir(), "ob-l2861r-"));
    file(d, "A");
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
      caps: [BUS_CAPS.ids, BUS_CAPS.link],
    });
    const upA = await h.next("agent_up");
    h.toDaemon({ id: upA.id, type: "agent_ok", agent_ref: "A", bus_name: "n" });
    await daemonLinkProof({ path: h.socketPath, pid: 4242, hash: H1 });
    await vi.waitFor(() => expect(h.of("link_bind")).toHaveLength(1));
    // The resumed session's MCP hello arrives while the file still lists A.
    await h.adapter("B", { kind: "claude-code", pid: 4242, cwd: "/repo" });
    const upB = await h.next("agent_up", 2);
    expect(upB.agent_ref).toBe("B");
    h.toDaemon({ id: upB.id, type: "agent_ok", agent_ref: "B", bus_name: "n" });
    // The file switches; the next sync closes A.
    file(d, "B");
    await vi.waitFor(() =>
      expect(h.daemon.agents.byRef("A")?.live).toBe(false),
    );
    // The rebind is written after A closes: wake on the frame, not a clock.
    const bound = () =>
      h.of("link_bind").some((f) => f.agent_ref === "B" && f.hash === H1);
    if (!bound())
      await new Promise<void>((resolve) => {
        const off = h.onFrame(() => {
          if (!bound()) return;
          off();
          resolve();
        });
      });
    expect(bound()).toBe(true);
    const proofs = new Map<string, string>();
    for (const f of h.frames) {
      if (f.type === "link_bind") proofs.set(f.hash, f.agent_ref);
    }
    for (const [k, v] of [...proofs]) if (v === "A") proofs.delete(k);
    expect(proofs.get(H1)).toBe("B");
  });
});
