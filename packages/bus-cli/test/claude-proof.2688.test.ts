// #2688: the helper goes on every Claude entry for the instance (user and local
// scope), is re-applied when the daemon starts, and doctor says when an entry
// can't be linked. Everything runs in a throwaway home with stubbed exec.
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { daemon } from "../src/commands/daemon.ts";
import { doctor } from "../src/commands/doctor.ts";
import {
  type AdapterDeps,
  installAdapters,
  uninstallAdapters,
} from "../src/steps/adapters.ts";
import { isProofHelper } from "../src/steps/claude-proof.ts";
import { fakeCtx, TOKEN } from "./fake.ts";

const HUB = "https://oa.example.com";
const BIN = "/usr/local/bin/oa-bus";
const TOKEN_FILE = "~/.open-artifacts/oa-example-com-pat-token";
const TOKEN_HELPER = `T=$(cat ${TOKEN_FILE}) && printf '{"Authorization":"Bearer %s"}' "$T"`;
const PROJ_A = "/work/a";
const PROJ_B = "/work/b";
const http = (url = `${HUB}/mcp`, extra: object = {}) => ({
  type: "http",
  url,
  ...extra,
});

const claudeJson = (over: object = {}) =>
  JSON.stringify(
    {
      numStartups: 3,
      mcpServers: { "open-artifacts": http(), other: { type: "stdio" } },
      projects: {
        [PROJ_A]: { allowedTools: [], mcpServers: { oa: http(`${HUB}/mcp/`) } },
        [PROJ_B]: { mcpServers: { unrelated: http("https://x.test/mcp") } },
      },
      ...over,
    },
    null,
    2,
  );

const setup = (json: string | null = claudeJson()) => {
  const h = mkdtempSync(join(tmpdir(), "ob-proof-2688-"));
  const file = join(h, ".claude.json");
  if (json !== null) writeFileSync(file, json);
  const deps: AdapterDeps = {
    home: h,
    env: {},
    hub: HUB,
    busBin: [BIN],
    assets: { pi: "PI", opencodePlugin: "JS" },
    which: (c) => c === "claude",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  return { h, file, deps, read, text: () => readFileSync(file, "utf8") };
};
const helpers = (doc: {
  mcpServers: Record<string, { headersHelper?: string }>;
  projects: Record<
    string,
    { mcpServers: Record<string, { headersHelper?: string }> }
  >;
}) => ({
  user: doc.mcpServers["open-artifacts"]?.headersHelper,
  a: doc.projects[PROJ_A]?.mcpServers.oa?.headersHelper,
  b: doc.projects[PROJ_B]?.mcpServers.unrelated?.headersHelper,
});

describe("install and uninstall, every scope in ~/.claude.json", () => {
  it("adds the helper at user and local scope (a trailing slash too), and uninstall restores the bytes", async () => {
    const s = setup();
    const original = s.text();
    await installAdapters(s.deps);
    const h = helpers(s.read());
    expect(h.user).toBe(`${BIN} mcp-proof`);
    expect(h.a).toBe(`${BIN} mcp-proof`);
    // Another host's entry, other keys and the stdio entry are untouched.
    expect(h.b).toBeUndefined();
    expect(s.read().numStartups).toBe(3);
    expect(s.read().mcpServers.other).toEqual({ type: "stdio" });
    await uninstallAdapters(s.deps);
    expect(s.text()).toBe(original);
  });

  it("keeps a token helper's Authorization, and leaves a foreign helper alone with a note", async () => {
    const s = setup(
      claudeJson({
        mcpServers: { tok: http(undefined, { headersHelper: TOKEN_HELPER }) },
        projects: {
          [PROJ_A]: {
            mcpServers: { mine: http(undefined, { headersHelper: "my-own" }) },
          },
        },
      }),
    );
    const original = s.text();
    const r = await installAdapters(s.deps);
    const doc = s.read();
    expect(doc.mcpServers.tok.headersHelper).toContain(
      "mcp-proof --token-file",
    );
    expect(doc.mcpServers.tok.headersHelper).toContain(TOKEN_FILE);
    expect(doc.projects[PROJ_A].mcpServers.mine.headersHelper).toBe("my-own");
    expect(JSON.stringify(r)).toContain("left the headersHelper of mine");
    await uninstallAdapters(s.deps);
    expect(s.text()).toBe(original);
  });

  it("a second install writes nothing", async () => {
    const s = setup();
    await installAdapters(s.deps);
    const once = s.text();
    const rec = readFileSync(join(s.h, ".oa-bus/install.json"), "utf8");
    await installAdapters(s.deps);
    expect(s.text()).toBe(once);
    expect(readFileSync(join(s.h, ".oa-bus/install.json"), "utf8")).toBe(rec);
  });

  it("never edits a project-scope .mcp.json", async () => {
    const s = setup();
    const proj = join(s.h, ".mcp.json");
    const body = JSON.stringify({ mcpServers: { oa: http() } });
    writeFileSync(proj, body);
    await installAdapters(s.deps);
    expect(readFileSync(proj, "utf8")).toBe(body);
  });
});

describe("daemon start re-applies the helper", () => {
  const start = async (
    ctx: ReturnType<typeof fakeCtx>,
  ): Promise<ReturnType<typeof vi.fn>> => {
    const signals = new EventEmitter() as never;
    const run = vi.fn(async () => ({ stop: async () => {} }) as never);
    const done = daemon(ctx, run as never, signals);
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    (signals as unknown as EventEmitter).emit("SIGTERM");
    await done;
    return run;
  };
  const ctxFor = (s: ReturnType<typeof setup>) => {
    const ctx = fakeCtx({
      userHome: s.h,
      home: join(s.h, ".oa-bus"),
      env: {},
      service: {
        ensure: async () => ({}),
        remove: async () => ({}),
        cli: () => [BIN],
        argv: () => [BIN],
      },
    });
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(
      join(ctx.home, "machine.json"),
      JSON.stringify({
        hub: HUB,
        machine_id: "m",
        label: "l",
        machine_token: TOKEN,
      }),
    );
    return ctx;
  };

  it("gives a late-added entry the helper, logs name and scope only, and then writes nothing", async () => {
    const s = setup();
    await installAdapters(s.deps);
    // Added after install, at local scope and at user scope.
    const doc = s.read();
    doc.projects[PROJ_B].mcpServers.late = http();
    doc.mcpServers.late2 = http(`${HUB}/mcp/`);
    writeFileSync(s.file, JSON.stringify(doc, null, 2));
    const ctx = ctxFor(s);
    await start(ctx);
    const after = s.read();
    expect(after.projects[PROJ_B].mcpServers.late.headersHelper).toBe(
      `${BIN} mcp-proof`,
    );
    expect(after.mcpServers.late2.headersHelper).toBe(`${BIN} mcp-proof`);
    // Nothing else changed.
    expect(after.projects[PROJ_B].mcpServers.unrelated).toEqual(
      doc.projects[PROJ_B].mcpServers.unrelated,
    );
    const logFile = join(ctx.home, "logs/events.log");
    await vi.waitFor(() =>
      expect(readFileSync(logFile, "utf8")).toContain("late2"),
    );
    const log = readFileSync(logFile, "utf8");
    expect(log).toMatch(/claude_proof_applied name=late kind=local/);
    expect(log).toMatch(/claude_proof_applied name=late2 kind=user/);
    expect(log).not.toContain("mcp-proof");
    expect(log).not.toContain(PROJ_B);
    // A second start: no write at all.
    const bytes = s.text();
    const mtime = statSync(s.file).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    await start(ctx);
    expect(s.text()).toBe(bytes);
    expect(statSync(s.file).mtimeMs).toBe(mtime);
    // Uninstall takes the late entries' helpers off too.
    await uninstallAdapters(s.deps);
    expect(JSON.stringify(s.read())).not.toContain("mcp-proof");
  });

  it("refreshes a helper whose command line changed, and leaves a foreign helper and other hosts alone", async () => {
    const s = setup(
      claudeJson({
        projects: {
          [PROJ_A]: {
            mcpServers: { mine: http(undefined, { headersHelper: "my-own" }) },
          },
        },
      }),
    );
    await installAdapters(s.deps);
    const ctx = fakeCtx({
      ...ctxFor(s),
      service: {
        ensure: async () => ({}),
        remove: async () => ({}),
        cli: () => ["/new/oa-bus"],
        argv: () => ["/new/oa-bus"],
      },
    });
    await start(ctx);
    const doc = s.read();
    expect(doc.mcpServers["open-artifacts"].headersHelper).toBe(
      "/new/oa-bus mcp-proof",
    );
    expect(doc.projects[PROJ_A].mcpServers.mine.headersHelper).toBe("my-own");
  });

  it("does nothing without a config file", async () => {
    const s = setup(null);
    await start(ctxFor(s));
    expect(() => readFileSync(s.file)).toThrow();
  });
});

describe("doctor, Claude entries (#2688)", () => {
  const lines = async (
    s: ReturnType<typeof setup>,
    cwdFile?: object,
    log?: string,
  ) => {
    const cwd = mkdtempSync(join(tmpdir(), "ob-proof-cwd-"));
    if (cwdFile) writeFileSync(join(cwd, ".mcp.json"), JSON.stringify(cwdFile));
    const ctx = fakeCtx({
      userHome: s.h,
      home: join(s.h, ".oa-bus"),
      cwd,
      env: {},
      nodeVersion: "v22.11.0",
      which: (c) => c === "claude",
      exec: vi.fn(async () => ({ code: 0, stdout: "2.1.318", stderr: "" })),
    });
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(
      join(ctx.home, "machine.json"),
      JSON.stringify({
        hub: HUB,
        machine_id: "m",
        label: "l",
        machine_token: TOKEN,
      }),
    );
    if (log) {
      mkdirSync(join(ctx.home, "logs"), { recursive: true });
      writeFileSync(join(ctx.home, "logs/events.log"), log);
    }
    await doctor(ctx);
    return ctx.all().filter((l) => /^( {2}Fix|Claude Code: )/.test(l));
  };

  it("passes for each entry that has the helper", async () => {
    const s = setup();
    await installAdapters(s.deps);
    const out = await lines(s);
    expect(out).toEqual([
      "Claude Code: the open-artifacts entry (user scope) shows as this session on pages.",
      "Claude Code: the oa entry (local scope, project /work/a) shows as this session on pages.",
    ]);
  });

  it("fails with the fix for an entry with no helper, and one with someone else's", async () => {
    const s = setup(
      claudeJson({
        projects: {
          [PROJ_A]: {
            mcpServers: { mine: http(undefined, { headersHelper: "my-own" }) },
          },
        },
      }),
    );
    const out = await lines(s);
    expect(out).toEqual([
      "Claude Code: the open-artifacts entry (user scope) has no session helper, so what it posts can't be tied to this session.",
      `  Fix: ${"npx @open-artifacts/bus"} install`,
      "Claude Code: the mine entry (local scope, project /work/a) has a headersHelper that is not oa-bus's, so oa-bus left it alone.",
      expect.stringMatching(
        /^ {2}Fix: remove that headersHelper from the entry in .*\.claude\.json, then run .* install$/,
      ),
    ]);
  });

  it("fails for a project-scope entry in this folder, with the one-line fix", async () => {
    const s = setup(claudeJson({ projects: {} }));
    await installAdapters(s.deps);
    const out = await lines(s, { mcpServers: { projA: http() } });
    expect(out).toContain(
      "Claude Code: the projA entry (project scope, .mcp.json in this folder) can't show as this session: Claude skips the helper on project-scope entries.",
    );
    expect(out).toContain(
      `  Fix: claude mcp remove projA -s project, then claude mcp add --transport http projA ${HUB}/mcp -s user, then npx @open-artifacts/bus install`,
    );
  });

  it("warns when there is no entry at all, and for the same host at another path", async () => {
    const none = await lines(
      setup(claudeJson({ mcpServers: {}, projects: {} })),
    );
    expect(none[0]).toBe(
      "Claude Code: no entry for oa.example.com was found at user, local or project scope.",
    );
    const other = await lines(
      setup(
        claudeJson({
          mcpServers: { x: http(`${HUB}/v2/mcp`) },
          projects: {},
        }),
      ),
    );
    expect(other).toContain(
      `Claude Code: the x entry (user scope) points at ${HUB}/v2/mcp, not ${HUB}/mcp, so it can't be linked.`,
    );
  });

  it("shows what the last automatic fix changed, from the log", async () => {
    const s = setup();
    await installAdapters(s.deps);
    const out = await lines(
      s,
      undefined,
      "2026-11-17T08:00:00.000Z claude_proof_applied name=late kind=local\n",
    );
    expect(out).toContain(
      "Claude Code: the last automatic fix (2026-11-17 08:00 UTC) added the helper to late (local scope).",
    );
  });

  it("never prints a header value", async () => {
    const s = setup(
      claudeJson({
        mcpServers: { tok: http(undefined, { headersHelper: TOKEN_HELPER }) },
      }),
    );
    await installAdapters(s.deps);
    const out = (await lines(s)).join("\n");
    expect(out).not.toContain(TOKEN_FILE);
    expect(out).not.toContain("mcp-proof");
    expect(isProofHelper(s.read().mcpServers.tok.headersHelper)).toBe(true);
  });
});

describe("doctor, Codex and OpenCode entries the proxy swap skipped", () => {
  it("warns, by name, for an OAuth Codex entry and an OpenCode entry that signs in with auth", async () => {
    const h = mkdtempSync(join(tmpdir(), "ob-proof-2688-x-"));
    mkdirSync(join(h, ".codex"), { recursive: true });
    writeFileSync(
      join(h, ".codex/config.toml"),
      `[mcp_servers.oa-codex]\nurl = "${HUB}/mcp"\n`,
    );
    mkdirSync(join(h, ".config/opencode"), { recursive: true });
    writeFileSync(
      join(h, ".config/opencode/opencode.json"),
      JSON.stringify({
        mcp: { "oa-oc": { type: "remote", url: `${HUB}/mcp`, oauth: {} } },
      }),
    );
    const ctx = fakeCtx({
      userHome: h,
      home: join(h, ".oa-bus"),
      env: {},
      nodeVersion: "v22.11.0",
      which: (c) => c === "codex" || c === "opencode",
      exec: vi.fn(async (cmd: string) => ({
        code: 0,
        stdout: cmd === "opencode" ? "2.1.0" : "codex-cli 0.167.0",
        stderr: "",
      })),
    });
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(
      join(ctx.home, "machine.json"),
      JSON.stringify({
        hub: HUB,
        machine_id: "m",
        label: "l",
        machine_token: TOKEN,
      }),
    );
    await doctor(ctx);
    const all = ctx.all().join("\n");
    expect(all).toContain("Codex: left the oa-codex entry");
    expect(all).toContain("OpenCode: left the oa-oc entry");
  });
});
