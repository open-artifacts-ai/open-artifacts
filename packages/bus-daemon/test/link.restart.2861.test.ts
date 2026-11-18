// #2861: a restart or a second helper run must not unlink a Claude session.
// Claude keeps sending the FIRST proof the helper minted, so the daemon keeps
// it (never drops the oldest), and a pending proof keeps its first hash too.
// A pid that called THIS home's helper is adopted even where the scan skips it
// (#2806); a scanned session that never called it is still left alone.
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

const hx = (i: number) => i.toString(16).padStart(2, "0").repeat(32);
const session = (d: string, pid = 4242) =>
  writeFileSync(
    join(d, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: `s-${pid}`,
      procStart: "t0",
      name: "open-artifacts-9e",
      messagingSocketPath: "",
      cwd: "/repo",
    }),
  );
const hello = (h: Awaited<ReturnType<typeof daemonHarness>>) =>
  h.toDaemon({
    id: "w",
    type: "hello_ok",
    machine_id: "1".repeat(16),
    machine_label: "laptop",
    server_version: "1",
    caps: [BUS_CAPS.ids, BUS_CAPS.link],
  });
const ok = (h: Awaited<ReturnType<typeof daemonHarness>>, ref: string) =>
  h.toDaemon({
    id: h.of("agent_up").at(-1)?.id as string,
    type: "agent_ok",
    agent_ref: ref,
    bus_name: "open-artifacts-9e",
  });

describe("the proof in use survives (#2861)", () => {
  it("T1: the first hash is replayed after a restart, past 20 helper runs", async () => {
    const d = mkdtempSync(join(tmpdir(), "ob-l2861-"));
    const linksFile = join(mkdtempSync(join(tmpdir(), "ob-l2861h-")), "l.json");
    session(d);
    const boot = async () => {
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
      await h.next("agent_up");
      ok(h, "s-4242");
      return h;
    };
    const one = await boot();
    for (let i = 1; i <= 20; i++)
      await daemonLinkProof({ path: one.socketPath, pid: 4242, hash: hx(i) });
    await vi.waitFor(() => expect(one.of("link_bind")).toHaveLength(20));
    await one.daemon.stop();
    const two = await boot();
    await vi.waitFor(() => expect(two.of("link_bind")).toHaveLength(16));
    const got = two.of("link_bind").map((f) => f.hash);
    expect(got[0]).toBe(hx(1));
    expect(got).toContain(hx(20));
  });

  it("T2: two proofs for a pid the scan hides both bind once the session is adopted", async () => {
    const d = mkdtempSync(join(tmpdir(), "ob-l2861-"));
    session(d);
    const h = await daemonHarness({
      claude: {
        sessionsDir: d,
        socketsDir: join(d, "r"),
        syncMs: 3_600_000,
        procStart: () => "t0",
        isRunning: () => true,
        discover: false,
      },
    });
    hello(h);
    expect(
      await daemonLinkProof({ path: h.socketPath, pid: 4242, hash: hx(1) }),
    ).toBe(true);
    expect(
      await daemonLinkProof({ path: h.socketPath, pid: 4242, hash: hx(2) }),
    ).toBe(true);
    await h.next("agent_up");
    ok(h, "s-4242");
    await vi.waitFor(() => expect(h.of("link_bind")).toHaveLength(2));
    expect(h.of("link_bind").map((f) => f.hash)).toEqual([hx(1), hx(2)]);
  });

  it("T3: a scanned session that never called this home's helper is not adopted (#2806)", async () => {
    const d = mkdtempSync(join(tmpdir(), "ob-l2861-"));
    session(d, 4242);
    session(d, 4343);
    const h = await daemonHarness({
      claude: {
        sessionsDir: d,
        socketsDir: join(d, "r"),
        syncMs: 3_600_000,
        procStart: () => "t0",
        isRunning: () => true,
        discover: false,
      },
    });
    hello(h);
    await daemonLinkProof({ path: h.socketPath, pid: 4242, hash: hx(1) });
    await h.next("agent_up");
    expect(h.of("agent_up").map((f) => f.agent_ref)).toEqual(["s-4242"]);
    expect(h.daemon.agents.byRef("s-4343")).toBeUndefined();
  });

  it("T3b: a helper pid whose process belongs to another home is not adopted (#2806)", async () => {
    const d = mkdtempSync(join(tmpdir(), "ob-l2861-"));
    session(d, 4242);
    const h = await daemonHarness({
      claude: {
        sessionsDir: d,
        socketsDir: join(d, "r"),
        syncMs: 3_600_000,
        procStart: () => "t0",
        isRunning: () => true,
        discover: false,
        homeOf: () => join(tmpdir(), ".oa-bus-other"),
      },
    });
    hello(h);
    // The proof's own sync runs before it answers: nothing is adopted by then.
    await daemonLinkProof({ path: h.socketPath, pid: 4242, hash: hx(1) });
    expect(h.daemon.agents.byRef("s-4242")).toBeUndefined();
    expect(h.of("agent_up")).toEqual([]);
  });
});
