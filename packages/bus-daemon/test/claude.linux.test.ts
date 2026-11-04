import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProcStartOf } from "@oa/bus-adapter-claude-code";
import { describe, expect, it } from "vitest";
import { attest, procStartOf } from "../src/attest.ts";
import { liveClaudeSessions } from "../src/liveness/claude.ts";
import { lstartEpoch } from "../src/presence/opencode.ts";
import { hello } from "./helpers.ts";

/** Claude on Linux writes procStart as field 22 of /proc/<pid>/stat. */
const TICKS = "207774019";
const stat = (starttime: string) =>
  `4242 (claude) S 1 4242 4242 0 -1 4194560 100 0 0 0 5 2 0 0 20 0 11 0 ${starttime} 1000 50`;
const linux = (starttime: string | null) => (pid: number) =>
  claudeProcStartOf(pid, {
    platform: "linux",
    readStat: () => {
      if (starttime === null) throw new Error("ENOENT");
      return stat(starttime);
    },
  });

const sessions = () => {
  const d = mkdtempSync(join(tmpdir(), "ob-linux-"));
  writeFileSync(
    join(d, "4242.json"),
    JSON.stringify({
      pid: 4242,
      sessionId: "s4242",
      procStart: TICKS,
      name: "linux",
      messagingSocketPath: "/tmp/cc-socks/4242.sock",
      cwd: "/repo",
    }),
  );
  return d;
};

describe("Claude on Linux", () => {
  const check = (starttime: string | null) =>
    attest(hello({ kind: "claude-code", agent_ref: "s4242", pid: 5000 }), {
      sessionsDir: sessions(),
      ancestors: () => [5000, 4242],
      procStart: linux(starttime),
    });

  it("attests a session by its start ticks", () => {
    expect(check(TICKS)).toEqual({ ok: true, cwd: "/repo", pid: 4242 });
  });

  it("refuses a reused pid at attestation", () => {
    expect(check("207774020")).toEqual({
      ok: false,
      reason: "session process start time moved",
    });
  });

  it("refuses a pid whose /proc entry is gone", () => {
    expect(check(null)).toEqual({
      ok: false,
      reason: "session process is not running",
    });
  });

  it("keeps a live session live and drops a reused pid", () => {
    const live = (starttime: string | null) =>
      liveClaudeSessions({
        dir: sessions(),
        procStart: linux(starttime),
        isRunning: () => true,
      }).map((s) => s.ref);
    expect(live(TICKS)).toEqual(["s4242"]);
    expect(live("207774020")).toEqual([]);
    expect(live(null)).toEqual([]);
  });
});

describe("Pi and OpenCode keep lstart", () => {
  it("attests pi by the lstart its extension writes", () => {
    const mine = procStartOf(process.pid) as string;
    expect(mine).toMatch(/^\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
    expect(
      attest(
        hello({
          kind: "pi",
          agent_ref: "p1",
          pid: process.pid,
          attest: { proc_start: mine },
        }),
      ),
    ).toEqual({ ok: true });
  });

  it("reads OpenCode's start as an epoch from lstart", () => {
    expect(lstartEpoch(procStartOf(process.pid))).toEqual(expect.any(Number));
  });
});
