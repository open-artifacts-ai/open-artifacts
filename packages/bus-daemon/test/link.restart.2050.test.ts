// #2050: a daemon restart keeps a live Claude session linked. Claude never
// re-runs its headersHelper, so the daemon keeps the proof hashes (never the
// proofs) in its home, keyed by pid + procStart, and replays them after the
// restart. Waits are signals, never sleeps.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

function world() {
  const d = mkdtempSync(join(tmpdir(), "ob-l2050-"));
  const linksFile = join(mkdtempSync(join(tmpdir(), "ob-l2050h-")), "l.json");
  const state = { start: "t0" };
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
  const boot = async () => {
    const h = await daemonHarness({
      claude: {
        sessionsDir: d,
        socketsDir: join(d, "r"),
        syncMs: 20,
        procStart: () => state.start,
        isRunning: () => true,
        linksFile,
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
  };
  return { boot, linksFile, state, dir: d };
}

describe("link hashes survive a daemon restart (#2050)", () => {
  it("replays the held hashes after a restart, with no new proof", async () => {
    const w = world();
    const one = await w.boot();
    await daemonLinkProof({ path: one.socketPath, pid: 4242, hash: HASH });
    await daemonLinkProof({ path: one.socketPath, pid: 4242, hash: HASH2 });
    await vi.waitFor(() => expect(one.of("link_bind")).toHaveLength(2));
    expect(statSync(w.linksFile).mode & 0o777).toBe(0o600);
    const text = readFileSync(w.linksFile, "utf8");
    expect(JSON.parse(text).links).toEqual([
      { pid: 4242, procStart: "t0", hashes: [HASH, HASH2] },
    ]);
    await one.daemon.stop();

    const two = await w.boot();
    await vi.waitFor(() => expect(two.of("link_bind")).toHaveLength(2));
    expect(two.of("link_bind")).toMatchObject([
      { agent_ref: "s-a", hash: HASH },
      { agent_ref: "s-a", hash: HASH2 },
    ]);
  });

  it("a reused pid with another procStart gets nothing", async () => {
    const w = world();
    const one = await w.boot();
    await daemonLinkProof({ path: one.socketPath, pid: 4242, hash: HASH });
    await vi.waitFor(() => expect(one.of("link_bind")).toHaveLength(1));
    await one.daemon.stop();

    // The pid now runs another process: same pid, new start.
    w.state.start = "t9";
    writeFileSync(
      join(w.dir, "4242.json"),
      JSON.stringify({
        pid: 4242,
        sessionId: "s-a",
        procStart: "t9",
        name: "open-artifacts-9e",
        messagingSocketPath: "",
        cwd: "/repo",
      }),
    );
    const two = await w.boot();
    // Signal: a proof for the new process binds alone.
    await daemonLinkProof({ path: two.socketPath, pid: 4242, hash: HASH2 });
    await two.next("link_bind");
    expect(two.of("link_bind").map((f) => f.hash)).toEqual([HASH2]);
    // The stale entry is gone from the file.
    expect(JSON.parse(readFileSync(w.linksFile, "utf8")).links).toEqual([
      { pid: 4242, procStart: "t9", hashes: [HASH2] },
    ]);
  });

  it("ignores a corrupt file", async () => {
    const w = world();
    writeFileSync(w.linksFile, "{not json", { mode: 0o600 });
    const h = await w.boot();
    await daemonLinkProof({ path: h.socketPath, pid: 4242, hash: HASH });
    await h.next("link_bind");
    expect(h.of("link_bind").map((f) => f.hash)).toEqual([HASH]);
  });

  it("ignores a file others can write", async () => {
    const w = world();
    writeFileSync(
      w.linksFile,
      JSON.stringify({
        v: 1,
        links: [{ pid: 4242, procStart: "t0", hashes: [HASH] }],
      }),
      { mode: 0o666 },
    );
    (await import("node:fs")).chmodSync(w.linksFile, 0o666);
    const h = await w.boot();
    await daemonLinkProof({ path: h.socketPath, pid: 4242, hash: HASH2 });
    await h.next("link_bind");
    expect(h.of("link_bind").map((f) => f.hash)).toEqual([HASH2]);
  });
});
