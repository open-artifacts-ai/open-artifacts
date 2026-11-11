// The Claude Code plugins step (#2095): a fake `claude` and temp homes. No real claude is run.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copy } from "../src/copy.ts";
import {
  claudePluginsState,
  installClaudePlugins,
  marketplaceSource,
  SHORTCUTS_PLUGIN,
  STYLE_PLUGIN,
  uninstallClaudePlugins,
} from "../src/steps/claude-plugins.ts";

const c = copy({ color: "none", dark: true, utf8: true }, "oa-bus");
const ORIGIN = "https://oa.example.com";

type Market = Record<string, string>;
type Fake = {
  calls: string[][];
  inputs: (string | undefined)[];
  version: string | "missing";
  markets: Market[];
  installed: string[];
  config: Record<string, string>;
  mcpList: string | "timeout";
  failAdd?: boolean;
  failInstall?: string;
  exec: (
    cmd: string,
    args: string[],
    opts?: { input?: string; timeoutMs?: number },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
};

const ok = (o: object) => ({
  code: 0,
  stdout: `${JSON.stringify({ outcome: "ok", ...o })}\n`,
  stderr: "",
});
const bad = (failureCode: string, message: string) => ({
  code: 1,
  stdout: `${JSON.stringify({ outcome: "failed", failureCode, message })}\n`,
  stderr: `x ${message}\n`,
});

const fake = (over: Partial<Fake> = {}): Fake => {
  const f: Fake = {
    calls: [],
    inputs: [],
    version: "2.1.322",
    markets: [],
    installed: [],
    config: {},
    mcpList: "",
    ...over,
    exec: async (cmd, args, opts) => {
      f.calls.push([cmd, ...args]);
      f.inputs.push(opts?.input);
      if (cmd !== "claude") throw new Error(`unexpected ${cmd}`);
      if (f.version === "missing")
        return { code: 1, stdout: "", stderr: "Error: spawn claude ENOENT" };
      const [a, b, d] = args;
      if (a === "--version")
        return { code: 0, stdout: `${f.version} (Claude Code)\n`, stderr: "" };
      if (a === "mcp") {
        if (f.mcpList === "timeout")
          return { code: 1, stdout: "", stderr: "timed out after 20000 ms" };
        return { code: 0, stdout: f.mcpList, stderr: "" };
      }
      if (b === "marketplace" && d === "list")
        return { code: 0, stdout: JSON.stringify(f.markets), stderr: "" };
      if (b === "marketplace" && d === "add") {
        if (f.failAdd) return bad("clone_failed", "Clone failed");
        const src = args[3] as string;
        const [url, ref] = src.split("#");
        f.markets = [
          {
            name: "open-artifacts",
            source: "git",
            url: url as string,
            ...(ref ? { ref } : {}),
          },
        ];
        return ok({ marketplace: "open-artifacts" });
      }
      if (b === "marketplace" && d === "remove") {
        if (!f.markets.length) return bad("not_configured", "not found");
        f.markets = [];
        f.installed = f.installed.filter((i) => !i.endsWith("@open-artifacts"));
        return ok({});
      }
      if (b === "list")
        return {
          code: 0,
          stdout: JSON.stringify(f.installed.map((id) => ({ id }))),
          stderr: "",
        };
      if (b === "install") {
        const id = d as string;
        if (f.failInstall === id) return bad("install_failed", "no");
        if (!f.installed.includes(id)) f.installed.push(id);
        for (let i = 3; i < args.length; i++)
          if (args[i] === "--config") {
            const [k, ...v] = (args[i + 1] as string).split("=");
            f.config[k as string] = v.join("=");
          }
        return ok({ pluginId: id });
      }
      if (b === "uninstall") {
        const id = args[2] as string;
        if (!f.installed.includes(id)) return bad("not_installed", "not found");
        f.installed = f.installed.filter((i) => i !== id);
        return ok({});
      }
      if (b === SHORTCUTS_PLUGIN || a === "plugin")
        return {
          code: 0,
          stdout: JSON.stringify({ inputs: f.config }),
          stderr: "",
        };
      throw new Error(`unexpected claude ${args.join(" ")}`);
    },
  };
  return f;
};

const setup = () => {
  const home = mkdtempSync(join(tmpdir(), "oa-plug-home-"));
  const busHome = mkdtempSync(join(tmpdir(), "oa-plug-bus-"));
  return { home, busHome };
};
const record = (busHome: string) => {
  const p = join(busHome, "install.json");
  return existsSync(p)
    ? JSON.parse(readFileSync(p, "utf8")).claudePlugins
    : undefined;
};
const run = (f: Fake, w: { home: string; busHome: string }, over = {}) =>
  installClaudePlugins(
    {
      ...w,
      exec: f.exec,
      version: "0.154.0",
      origin: ORIGIN,
      copy: c,
      ...over,
    },
    ["claude"],
  );
const FOUND =
  "oa: https://oa.example.com/mcp (HTTP) - ✓ Connected\nother: https://x.example/mcp (HTTP) - ✓ Connected\n";

describe("marketplaceSource", () => {
  it("pins a release to its tag and a dev build to the default branch", () => {
    expect(marketplaceSource("0.154.0")).toBe(
      "https://github.com/open-artifacts-ai/open-artifacts.git#v0.154.0",
    );
    expect(marketplaceSource("0.0.0")).toBe(
      "https://github.com/open-artifacts-ai/open-artifacts.git",
    );
    expect(marketplaceSource("0.154.0-rc.1")).not.toContain("#");
  });
});

describe("installClaudePlugins", () => {
  it("adds the marketplace, installs both plugins configured for the instance, and records them", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND });
    const r = await run(f, w);
    expect(r.ok).toBe(true);
    expect(f.markets[0]).toMatchObject({ ref: "v0.154.0" });
    expect(f.installed.sort()).toEqual([SHORTCUTS_PLUGIN, STYLE_PLUGIN].sort());
    expect(f.config).toEqual({ instanceUrl: `${ORIGIN}/mcp`, mcpServer: "oa" });
    expect(record(w.busHome)).toEqual({
      marketplace: true,
      plugins: [STYLE_PLUGIN, SHORTCUTS_PLUGIN],
    });
    // Every call went through exec with --json where it has one, nothing else.
    for (const call of f.calls) expect(call[0]).toBe("claude");
    expect(f.calls.some((x) => x.includes("--sparse"))).toBe(true);
  });

  it("uses open-artifacts with a note when the list times out, and when nothing matches", async () => {
    for (const mcpList of [
      "timeout",
      "other: https://x.example/mcp (HTTP)\n",
    ]) {
      const w = setup();
      const f = fake({ mcpList });
      const r = await run(f, w);
      expect(f.config.mcpServer).toBe("open-artifacts");
      expect(r.notes.join(" ")).toContain('"open-artifacts"');
    }
    const w = setup();
    const f = fake({ mcpList: "timeout" });
    await run(f, w);
    const timeoutCall = f.calls.find((x) => x[1] === "mcp");
    expect(timeoutCall).toEqual(["claude", "mcp", "list"]);
  });

  it("is idempotent: a second run adds nothing and records nothing new", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND });
    await run(f, w);
    const adds = () => f.calls.filter((x) => x[3] === "add").length;
    expect(adds()).toBe(1);
    await run(f, w);
    expect(adds()).toBe(1);
    expect(record(w.busHome)).toEqual({
      marketplace: true,
      plugins: [STYLE_PLUGIN, SHORTCUTS_PLUGIN],
    });
  });

  it("keeps the namespace on a rerun when it cannot be found", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND });
    await run(f, w);
    f.mcpList = "timeout";
    await run(f, w);
    expect(f.config.mcpServer).toBe("oa");
  });

  it("repoints our own marketplace to this release, and does not claim it", async () => {
    const w = setup();
    const f = fake({
      mcpList: FOUND,
      markets: [
        {
          name: "open-artifacts",
          source: "github",
          repo: "open-artifacts-ai/open-artifacts",
        },
      ],
    });
    await run(f, w);
    expect(f.markets[0]).toMatchObject({ ref: "v0.154.0" });
    expect(record(w.busHome).marketplace).toBe(false);
  });

  it("leaves a foreign marketplace of the same name alone, with a note", async () => {
    const w = setup();
    const f = fake({
      markets: [
        { name: "open-artifacts", source: "directory", path: "/somewhere" },
      ],
    });
    const r = await run(f, w);
    expect(f.calls.some((x) => x[3] === "add" || x[2] === "install")).toBe(
      false,
    );
    expect(f.markets).toHaveLength(1);
    expect(r.notes.join(" ")).toContain("isn't from Open Artifacts");
    expect(record(w.busHome)).toBeUndefined();
  });

  it("does not record a plugin the user installed first", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND, installed: [STYLE_PLUGIN] });
    await run(f, w);
    expect(record(w.busHome).plugins).toEqual([SHORTCUTS_PLUGIN]);
  });

  it("skips with a note when claude is missing or too old, and runs nothing else", async () => {
    for (const [version, text] of [
      ["missing", "isn't on PATH"],
      ["2.1.300", "too old"],
    ] as const) {
      const w = setup();
      const f = fake({ version });
      const r = await run(f, w);
      expect(r.notes.join(" ")).toContain(text);
      expect(f.calls).toHaveLength(1);
      expect(record(w.busHome)).toBeUndefined();
    }
  });

  it("does nothing when Claude Code is not among the harnesses", async () => {
    const w = setup();
    const f = fake();
    const r = await installClaudePlugins(
      { ...w, exec: f.exec, version: "0.154.0", origin: ORIGIN, copy: c },
      ["pi"],
    );
    expect(r.notes).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it("a failed marketplace add is a note, with nothing recorded", async () => {
    const w = setup();
    const f = fake({ failAdd: true });
    const r = await run(f, w);
    expect(r.ok).toBeUndefined();
    expect(r.notes.join(" ")).toContain("Could not add the plugin source");
    expect(record(w.busHome)).toBeUndefined();
  });

  it("a failed plugin install is a note; the other one still installs and is recorded", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND, failInstall: STYLE_PLUGIN });
    const r = await run(f, w);
    expect(r.ok).toBe(false);
    expect(record(w.busHome).plugins).toEqual([SHORTCUTS_PLUGIN]);
  });

  it("moves an older install's style file and setting over to the plugin", async () => {
    const w = setup();
    const dir = join(w.home, ".claude/output-styles");
    mkdirSync(dir, { recursive: true });
    const marker =
      "<!-- managed by the Open Artifacts bus installer: edits are replaced on reinstall. -->";
    writeFileSync(
      join(dir, "artifacts-teammate.md"),
      `---\nname: Artifacts Teammate\n---\n${marker}\nbody\n`,
    );
    writeFileSync(
      join(w.home, ".claude/settings.json"),
      '{"outputStyle":"Artifacts Teammate"}\n',
    );
    writeFileSync(
      join(w.busHome, "install.json"),
      JSON.stringify({
        outputStyle: {
          set: true,
          value: "Artifacts Teammate",
          before: { state: "absent" },
        },
      }),
    );
    await run(fake({ mcpList: FOUND }), w);
    expect(existsSync(join(dir, "artifacts-teammate.md"))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(w.home, ".claude/settings.json"), "utf8"))
        .outputStyle,
    ).toBe("open-artifacts:Artifacts Teammate");
  });

  it("turns the style on when unset, keeps a person's own choice", async () => {
    const a = setup();
    const r = await run(fake({ mcpList: FOUND }), a);
    expect(r.styleOn).toBe(true);
    expect(
      JSON.parse(readFileSync(join(a.home, ".claude/settings.json"), "utf8"))
        .outputStyle,
    ).toBe("open-artifacts:Artifacts Teammate");
    const b = setup();
    mkdirSync(join(b.home, ".claude"), { recursive: true });
    writeFileSync(
      join(b.home, ".claude/settings.json"),
      '{"outputStyle":"Explanatory"}\n',
    );
    const r2 = await run(fake({ mcpList: FOUND }), b);
    expect(r2.styleOn).toBeUndefined();
    expect(r2.keptStyle).toBe("Explanatory");
  });

  it("leaves the shortcuts unconfigured, without a failure, when the instance is unknown", async () => {
    const w = setup();
    const f = fake();
    await run(f, w, { origin: undefined });
    expect(f.installed).toContain(SHORTCUTS_PLUGIN);
    expect(f.config).toEqual({});
  });
});

describe("uninstallClaudePlugins", () => {
  const withInstall = async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND });
    await run(f, w);
    return { w, f };
  };

  it("removes what we recorded and the marketplace we added", async () => {
    const { w, f } = await withInstall();
    const r = await uninstallClaudePlugins({ ...w, exec: f.exec, copy: c });
    expect(r.notes).toEqual([]);
    expect(f.installed).toEqual([]);
    expect(f.markets).toEqual([]);
    expect(record(w.busHome)).toBeUndefined();
  });

  it("keeps the marketplace while another plugin from it remains", async () => {
    const { w, f } = await withInstall();
    f.installed.push("someone-else@open-artifacts");
    await uninstallClaudePlugins({ ...w, exec: f.exec, copy: c });
    expect(f.installed).toEqual(["someone-else@open-artifacts"]);
    expect(f.markets).toHaveLength(1);
  });

  it("never removes a marketplace or plugin it did not add", async () => {
    const w = setup();
    const f = fake({
      mcpList: FOUND,
      installed: [STYLE_PLUGIN],
      markets: [
        {
          name: "open-artifacts",
          source: "github",
          repo: "open-artifacts-ai/open-artifacts",
        },
      ],
    });
    await run(f, w);
    await uninstallClaudePlugins({ ...w, exec: f.exec, copy: c });
    expect(f.installed).toEqual([STYLE_PLUGIN]);
    expect(f.markets).toHaveLength(1);
  });

  it("with no record, runs nothing", async () => {
    const w = setup();
    const f = fake();
    expect(
      await uninstallClaudePlugins({ ...w, exec: f.exec, copy: c }),
    ).toEqual({ notes: [] });
    expect(f.calls).toEqual([]);
  });

  it("a plugin already gone is fine; a missing claude gives the manual commands", async () => {
    const { w, f } = await withInstall();
    f.installed = [];
    f.markets = [];
    expect(
      (await uninstallClaudePlugins({ ...w, exec: f.exec, copy: c })).notes,
    ).toEqual([]);
    const { w: w2, f: f2 } = await withInstall();
    f2.version = "missing";
    const r = await uninstallClaudePlugins({ ...w2, exec: f2.exec, copy: c });
    expect(r.notes.join(" ")).toContain(
      `claude plugin uninstall ${STYLE_PLUGIN}`,
    );
    expect(r.notes.join(" ")).toContain(
      "claude plugin marketplace remove open-artifacts",
    );
  });

  it("an uninstall that fails keeps the record, so a rerun finishes", async () => {
    const { w, f } = await withInstall();
    const orig = f.exec;
    f.exec = async (cmd, args, o) =>
      args[1] === "uninstall" && args[2] === STYLE_PLUGIN
        ? bad("boom", "boom")
        : orig(cmd, args, o);
    const r = await uninstallClaudePlugins({ ...w, exec: f.exec, copy: c });
    expect(r.notes.join(" ")).toContain("Could not remove");
    expect(record(w.busHome)).toBeDefined();
  });
});

describe("claudePluginsState", () => {
  it("is undefined when we installed nothing, ok after an install, and names a plugin that went missing", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND });
    expect(await claudePluginsState({ ...w, exec: f.exec })).toBeUndefined();
    await run(f, w);
    expect(await claudePluginsState({ ...w, exec: f.exec })).toEqual({
      missing: [],
      unconfigured: false,
    });
    f.installed = [STYLE_PLUGIN];
    expect((await claudePluginsState({ ...w, exec: f.exec }))?.missing).toEqual(
      [SHORTCUTS_PLUGIN],
    );
    f.installed = [STYLE_PLUGIN, SHORTCUTS_PLUGIN];
    f.config = {};
    expect(
      (await claudePluginsState({ ...w, exec: f.exec }))?.unconfigured,
    ).toBe(true);
  });
});
