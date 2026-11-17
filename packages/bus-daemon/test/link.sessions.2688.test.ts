// #2688: the daemon says which live Claude sessions got a proof, and why one
// did not. Causes and times only: no proof or hash is ever in the reply.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonLinkProof, daemonStatus } from "@oa/bus-ipc";
import { BUS_CAPS } from "@oa/bus-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(async () => {
  vi.useRealTimers();
  await stopAll();
});

const HASH = "a".repeat(64);

async function start(procStart = () => "t0") {
  const d = mkdtempSync(join(tmpdir(), "ob-sessions-"));
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
      procStart,
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
  await h.next("agent_up");
  h.toDaemon({
    id: h.of("agent_up")[0]?.id as string,
    type: "agent_ok",
    agent_ref: "s-a",
    bus_name: "open-artifacts-9e",
  });
  return h;
}
const status = (h: { socketPath: string }) =>
  daemonStatus({ path: h.socketPath, timeoutMs: 3000 });
/** Moves the clock on, so a session counts as past its first minutes. */
const later = (ms: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + ms);
};

describe("status lists Claude sessions and their link state (#2688)", () => {
  it("a session just seen is starting, not unlinked", async () => {
    const h = await start();
    expect((await status(h)).claude_sessions).toEqual([
      { name: "open-artifacts-9e", cwd: "/repo", state: "starting" },
    ]);
  });

  it("a linked session is linked", async () => {
    const h = await start();
    expect(
      await daemonLinkProof({ path: h.socketPath, pid: 4242, hash: HASH }),
    ).toBe(true);
    expect((await status(h)).claude_sessions?.[0]).toMatchObject({
      state: "linked",
    });
  });

  it("an old session with no proof is unlinked: its helper never called", async () => {
    const h = await start();
    later(3 * 60_000);
    expect((await status(h)).claude_sessions?.[0]).toMatchObject({
      state: "unlinked",
      cause: "no_helper_call",
    });
  });

  it("a proof from a reused pid is refused, and says so", async () => {
    let now = "t0";
    const h = await start(() => now);
    now = "t1";
    expect(
      await daemonLinkProof({ path: h.socketPath, pid: 4242, hash: HASH }),
    ).toBe(false);
    later(3 * 60_000);
    const st = await status(h);
    expect(st.claude_sessions?.[0]).toMatchObject({
      state: "unlinked",
      cause: "proof_refused",
    });
    expect(st.unbound_proofs?.at(-1)).toMatchObject({
      cause: "process_mismatch",
    });
  });

  it("a proof nobody claims expires and is listed with its cause", async () => {
    const h = await start();
    expect(
      await daemonLinkProof({ path: h.socketPath, pid: 9999, hash: HASH }),
    ).toBe(true);
    later(2 * 60_000);
    // The next sync tick expires it; poll with real timers.
    let ring: Awaited<ReturnType<typeof status>>["unbound_proofs"];
    for (let i = 0; i < 40 && !ring?.length; i++) {
      await new Promise((r) => setTimeout(r, 50));
      ring = (await status(h)).unbound_proofs;
    }
    expect(ring?.at(-1)).toMatchObject({ cause: "no_live_record" });
  });

  it("the reply holds no proof or hash", async () => {
    const h = await start();
    await daemonLinkProof({ path: h.socketPath, pid: 4242, hash: HASH });
    await daemonLinkProof({ path: h.socketPath, pid: 9999, hash: HASH });
    later(3 * 60_000);
    expect(JSON.stringify(await status(h))).not.toContain(HASH);
  });
});
