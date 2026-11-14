import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeSessionsDir,
  findSession,
  hasClaudeAncestor,
  lookupSession,
  NOT_UNDER_CLAUDE,
} from "../src/session.ts";

const sessions = () => mkdtempSync(join(tmpdir(), "ob-sess-"));
const session = (dir: string, pid: number, over: object = {}) => {
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: `s${pid}`,
      procStart: "t0",
      messagingSocketPath: `/tmp/cc-socks/${pid}.sock`,
      name: "my-session",
      ...over,
    }),
  );
  writeFileSync(
    join(dir, `${pid}.keyhash.key`),
    JSON.stringify({ peerToken: `tok${pid}`, procStart: "t0" }),
  );
};
const deps = (dir: string, over: object = {}) => ({
  sessionsDir: dir,
  ancestors: () => [500, 400, 300],
  procStart: () => "t0",
  sha256: () => "keyhash",
  ...over,
});

describe("claude session discovery", () => {
  it("finds the nearest ancestor with a session file and returns its token", () => {
    const dir = sessions();
    session(dir, 300);
    session(dir, 400);
    expect(findSession(500, deps(dir))).toEqual({
      pid: 400,
      sessionId: "s400",
      socketPath: "/tmp/cc-socks/400.sock",
      peerToken: "tok400",
      name: "my-session",
    });
  });

  it("#2311: an sdk-cli session never registers; cli and a missing entrypoint do", () => {
    const dir = sessions();
    session(dir, 400, { entrypoint: "sdk-cli" });
    expect(findSession(500, deps(dir))).toBeNull();
    session(dir, 400, { entrypoint: "sdk-cli", nameSource: "derived" });
    expect(findSession(500, deps(dir))).toBeNull();
    session(dir, 400, { entrypoint: "sdk-cli", nameSource: "user" });
    expect(findSession(500, deps(dir))?.sessionId).toBe("s400");
    session(dir, 400, { entrypoint: "sdk-cli", nameSource: "peer" });
    expect(findSession(500, deps(dir))?.sessionId).toBe("s400");
    session(dir, 400, { entrypoint: "cli" });
    expect(findSession(500, deps(dir))?.sessionId).toBe("s400");
    session(dir, 400, {});
    expect(findSession(500, deps(dir))?.sessionId).toBe("s400");
  });

  it("returns null when the process start moved", () => {
    const dir = sessions();
    session(dir, 400);
    expect(
      findSession(500, deps(dir, { procStart: () => "different" })),
    ).toBeNull();
  });

  it("never falls through to an outer session when the nearest is unusable", () => {
    const dir = sessions();
    session(dir, 300);
    session(dir, 400, { procStart: "old" });
    expect(findSession(500, deps(dir))).toBeNull();
  });

  it("never falls through to an outer session when the nearest file is mid-write or has no sessionId", () => {
    for (const text of ['{"pid":400,"sessionId":"s4', '{"pid":400}']) {
      const dir = sessions();
      session(dir, 300);
      writeFileSync(join(dir, "400.json"), text);
      expect(findSession(500, deps(dir))).toBeNull();
    }
  });

  it("finds a session that can send but not receive", () => {
    const dir = sessions();
    session(dir, 400, { messagingSocketPath: undefined });
    expect(findSession(500, deps(dir))).toMatchObject({
      sessionId: "s400",
      socketPath: null,
      peerToken: null,
    });
    const dir2 = sessions();
    writeFileSync(
      join(dir2, "400.json"),
      JSON.stringify({
        sessionId: "s",
        procStart: "t0",
        messagingSocketPath: "/x.sock",
      }),
    );
    expect(findSession(500, deps(dir2))).toMatchObject({
      socketPath: "/x.sock",
      peerToken: null,
    });
  });
});

describe("claude session hardening", () => {
  it("a session file without procStart is not a session", () => {
    const dir = sessions();
    session(dir, 400, { procStart: undefined });
    expect(findSession(500, deps(dir))).toBeNull();
  });

  it("a .key whose procStart is not the session's gives no token", () => {
    const dir = sessions();
    session(dir, 400);
    writeFileSync(
      join(dir, "400.keyhash.key"),
      JSON.stringify({ peerToken: "old", procStart: "t-old" }),
    );
    expect(findSession(500, deps(dir))).toMatchObject({ peerToken: null });
  });

  it("resolves the sessions dir from OA_BUS_CLAUDE_SESSIONS_DIR, else ~/.claude/sessions", () => {
    expect(claudeSessionsDir({ OA_BUS_CLAUDE_SESSIONS_DIR: "/x/s" })).toBe(
      "/x/s",
    );
    expect(claudeSessionsDir({})).toBe(join(homedir(), ".claude", "sessions"));
  });

  it("honours CLAUDE_CONFIG_DIR, with the override still first", () => {
    expect(claudeSessionsDir({ CLAUDE_CONFIG_DIR: "/cc" })).toBe(
      join("/cc", "sessions"),
    );
    expect(
      claudeSessionsDir({
        CLAUDE_CONFIG_DIR: "/cc",
        OA_BUS_CLAUDE_SESSIONS_DIR: "/x/s",
      }),
    ).toBe("/x/s");
  });
});

describe("claude ancestor (#1448 item 6)", () => {
  it("is false with no session file above, as under Pi importing Claude's MCP config", () => {
    expect(hasClaudeAncestor(500, deps(sessions()))).toBe(false);
  });

  it("is true for any session file above, even one findSession cannot use", () => {
    const dir = sessions();
    session(dir, 300, { procStart: undefined });
    expect(findSession(500, deps(dir))).toBeNull();
    expect(hasClaudeAncestor(500, deps(dir))).toBe(true);
  });

  it("tells a non-Claude harness to use its own tools, never to install", () => {
    expect(NOT_UNDER_CLAUDE).toBe(
      "This MCP server is for Claude Code; use this harness's own bus tools.",
    );
    expect(NOT_UNDER_CLAUDE).not.toMatch(/install/);
  });
});

describe("lookupSession reasons (#2364)", () => {
  const why = (dir: string, over: object = {}) => {
    const r = lookupSession(
      500,
      deps(dir, { ancestors: () => [500], ...over }),
    );
    return r.ok ? "ok" : r.reason;
  };
  it("names why a session is not found", () => {
    const none = sessions();
    expect(why(none)).toBe("none");
    const bad = sessions();
    writeFileSync(join(bad, "500.json"), "{not json");
    expect(why(bad)).toBe("unreadable");
    const parked = sessions();
    session(parked, 500, { parkedJobId: "j" });
    expect(why(parked)).toBe("not_session");
    const noStart = sessions();
    session(noStart, 500, { procStart: undefined });
    expect(why(noStart)).toBe("no_proc_start");
    const ok = sessions();
    session(ok, 500);
    expect(why(ok, { procStart: () => "other" })).toBe("proc_start_mismatch");
    expect(why(ok, { procStart: () => null })).toBe("proc_start_unknown");
    expect(why(ok)).toBe("ok");
  });
});
