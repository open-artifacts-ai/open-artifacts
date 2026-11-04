import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attest, claudeProcStartOf, procStartOf } from "../src/attest.ts";
import { daemonHarness, hello, stopAll } from "./helpers.ts";

const sessions = (file?: object) => {
  const dir = mkdtempSync(join(tmpdir(), "ob-claude-"));
  if (file)
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify(file));
  return dir;
};
const claude = (agent_ref: string) =>
  hello({ kind: "claude-code", agent_ref, pid: process.pid });
const deps = (sessionsDir: string, start: string | null = "x") => ({
  sessionsDir,
  ancestors: () => [process.pid],
  procStart: () => start,
});

describe("attestation", () => {
  it("refuses a claude agent_ref that does not match the ancestor session file", () => {
    const dir = sessions({
      pid: process.pid,
      sessionId: "other",
      procStart: "x",
    });
    expect(attest(claude("mine"), deps(dir))).toEqual({
      ok: false,
      reason: "agent_ref does not match a live Claude session",
    });
  });

  it("accepts the matching session when procStart agrees", () => {
    const dir = sessions({
      pid: process.pid,
      sessionId: "mine",
      procStart: "x",
      cwd: "/real/project",
    });
    expect(attest(claude("mine"), deps(dir))).toEqual({
      ok: true,
      cwd: "/real/project",
      pid: process.pid,
    });
  });

  it("refuses a reused pid whose procStart moved", () => {
    const dir = sessions({
      pid: process.pid,
      sessionId: "mine",
      procStart: "old",
    });
    expect(attest(claude("mine"), deps(dir, "new"))).toEqual({
      ok: false,
      reason: "session process start time moved",
    });
  });

  it("refuses a session whose process is gone", () => {
    const dir = sessions({
      pid: process.pid,
      sessionId: "mine",
      procStart: "x",
    });
    expect(attest(claude("mine"), deps(dir, null))).toEqual({
      ok: false,
      reason: "session process is not running",
    });
  });

  it("refuses when no ancestor has a session file", () => {
    expect(attest(claude("mine"), deps(sessions()))).toEqual({
      ok: false,
      reason: "no Claude session in the ancestry",
    });
  });

  it("binds omp to the real start of hello.pid, like pi (C23b)", async () => {
    const omp = (pid: number, proc_start?: string) =>
      hello({
        kind: "omp",
        agent_ref: "omp-1",
        pid,
        attest: proc_start ? { proc_start } : {},
      });
    expect(attest(omp(process.pid))).toEqual({
      ok: false,
      reason: "omp hello has no proc_start",
    });
    expect(attest(omp(1, "Mon Jan  1 00:00:00 2001"))).toEqual({
      ok: false,
      reason: "omp process start time moved",
    });
    const mine = procStartOf(process.pid) as string;
    expect(attest(omp(process.pid, mine))).toEqual({ ok: true });
    const h = await daemonHarness({ attest: undefined });
    await h.adapter("omp-1", { kind: "omp", attest: { proc_start: mine } });
    expect(h.daemon.agents.byRef("omp-1")).toMatchObject({ kind: "omp" });
  });

  it("refuses an opencode session with no live TUI presence file", () => {
    expect(
      attest(
        hello({
          kind: "opencode",
          agent_ref: "ses_1",
          attest: { session_id: "ses_1" },
        }),
        {
          openSessions: () => new Set(["ses_2"]),
          ancestors: () => [7],
          comm: () => "opencode",
        },
      ),
    ).toEqual({ ok: false, reason: "opencode session is not open in a TUI" });
  });

  it("attests an opencode hello only from a process under an opencode service", () => {
    const oc = (over: object = {}) =>
      hello({
        kind: "opencode",
        agent_ref: "ses_root",
        pid: 300,
        attest: { session_id: "ses_child" },
        ...over,
      });
    const comms: Record<number, string> = {
      300: "node",
      200: "/opt/homebrew/bin/opencode",
      100: "launchd",
    };
    const d = {
      openSessions: () => new Set(["ses_root"]),
      ancestors: () => [300, 200, 100],
      comm: (pid: number) => comms[pid] ?? null,
    };
    // The service's pid is the identity: its MCP child may restart.
    expect(attest(oc(), d)).toEqual({ ok: true, pid: 200 });
    expect(attest(oc({ attest: {} }), d)).toEqual({
      ok: false,
      reason: "opencode hello has no session_id",
    });
    expect(
      attest(oc(), { ...d, comm: (pid) => (pid === 200 ? "node" : null) }),
    ).toEqual({ ok: false, reason: "not running under an OpenCode service" });
    // `opencode-evil` or a path merely containing opencode is not opencode.
    expect(
      attest(oc(), {
        ...d,
        comm: (pid) => (pid === 200 ? "/tmp/opencode/opencode-evil" : null),
      }).ok,
    ).toBe(false);
  });

  it("attests no opencode session by default", () => {
    expect(attest(hello({ kind: "opencode", agent_ref: "ses_1" })).ok).toBe(
      false,
    );
  });

  it("checks a pi process and its start time", () => {
    const pi = (proc_start: string) =>
      hello({ kind: "pi", agent_ref: "p1", attest: { proc_start } });
    expect(attest(pi("a"), { procStart: () => null })).toEqual({
      ok: false,
      reason: "pi process is not running",
    });
    expect(attest(pi("a"), { procStart: () => "b" })).toEqual({
      ok: false,
      reason: "pi process start time moved",
    });
    expect(attest(pi("a"), { procStart: () => "a" })).toEqual({ ok: true });
  });

  it("requires a pi proc_start", () => {
    expect(
      attest(hello({ kind: "pi", agent_ref: "p1" }), { procStart: () => "a" }),
    ).toEqual({ ok: false, reason: "pi hello has no proc_start" });
  });

  it("binds pi to the real start of hello.pid", () => {
    const pi = (pid: number, proc_start: string) =>
      hello({ kind: "pi", agent_ref: "p1", pid, attest: { proc_start } });
    expect(attest(pi(1, "Mon Jan  1 00:00:00 2001")).ok).toBe(false);
    const mine = procStartOf(process.pid) as string;
    expect(attest(pi(process.pid, mine))).toEqual({ ok: true });
  });

  it("takes the nearest ancestor session as authoritative", () => {
    const dir = sessions();
    writeFileSync(
      join(dir, "300.json"),
      JSON.stringify({ sessionId: "B", procStart: "x", cwd: "/b" }),
    );
    writeFileSync(
      join(dir, "200.json"),
      JSON.stringify({ sessionId: "A", procStart: "x", cwd: "/a" }),
    );
    const as = (agent_ref: string) =>
      attest(hello({ kind: "claude-code", agent_ref, pid: 400 }), {
        sessionsDir: dir,
        ancestors: () => [400, 300, 200],
        procStart: () => "x",
      });
    expect(as("A")).toEqual({
      ok: false,
      reason: "agent_ref does not match a live Claude session",
    });
    // The session's own pid, not the MCP server's: the daemon's identity is the session.
    expect(as("B")).toEqual({ ok: true, cwd: "/b", pid: 300 });
  });

  it("refuses a Claude session file without an absolute cwd", () => {
    const dir = sessions({ sessionId: "mine", procStart: "x", cwd: "rel" });
    expect(attest(claude("mine"), deps(dir))).toEqual({
      ok: false,
      reason: "Claude session has no absolute cwd",
    });
  });
});

describe("procStartOf", () => {
  it("reads lstart in UTC and the C locale, as Claude writes procStart", () => {
    const tz = process.env.TZ;
    process.env.TZ = "Europe/Madrid";
    try {
      const utc = execFileSync(
        "ps",
        ["-o", "lstart=", "-p", String(process.pid)],
        {
          encoding: "utf8",
          env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
        },
      ).trim();
      expect(procStartOf(process.pid)).toBe(utc);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

describe("attestation hardening", () => {
  it("refuses a Claude session file without procStart", () => {
    const dir = sessions({ sessionId: "mine", cwd: "/real" });
    expect(attest(claude("mine"), deps(dir))).toEqual({
      ok: false,
      reason: "Claude session has no procStart",
    });
  });

  it("reads OA_BUS_CLAUDE_SESSIONS_DIR when no dir is given", () => {
    const dir = sessions({ sessionId: "mine", procStart: "x", cwd: "/real" });
    const prev = process.env.OA_BUS_CLAUDE_SESSIONS_DIR;
    process.env.OA_BUS_CLAUDE_SESSIONS_DIR = dir;
    try {
      expect(
        attest(claude("mine"), {
          ancestors: () => [process.pid],
          procStart: () => "x",
        }),
      ).toMatchObject({ ok: true, cwd: "/real" });
    } finally {
      if (prev === undefined) delete process.env.OA_BUS_CLAUDE_SESSIONS_DIR;
      else process.env.OA_BUS_CLAUDE_SESSIONS_DIR = prev;
    }
  });
});

describe("runDaemon's default attestation", () => {
  afterEach(async () => {
    await stopAll();
    vi.unstubAllEnvs();
  });

  it("reads Claude sessions from deps.claude.sessionsDir, the dir liveness reads", async () => {
    // The fallback resolver would look in an empty home, never the real one.
    vi.stubEnv("HOME", mkdtempSync(join(tmpdir(), "ob-home-")));
    vi.stubEnv("OA_BUS_CLAUDE_SESSIONS_DIR", "");
    const cwd = mkdtempSync(join(tmpdir(), "ob-cwd-"));
    const dir = sessions({
      pid: process.pid,
      sessionId: "claude-seam",
      procStart: claudeProcStartOf(process.pid),
      cwd,
    });
    const h = await daemonHarness({
      attest: undefined,
      claude: { sessionsDir: dir },
    });
    const c = await h.adapter("claude-seam", { kind: "claude-code" });
    expect(c.welcome).toMatchObject({ type: "welcome" });
    expect(h.daemon.agents.byRef("claude-seam")).toMatchObject({
      kind: "claude-code",
      pid: process.pid,
      cwd,
    });
  });
});
