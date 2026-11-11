// The Claude Code plugins step (#2095): a fake `claude` and temp homes. No real claude is run.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  mcpList: string | "timeout" | "none" | "error";
  /** installed -> available version, for plugins whose install reports both. */
  versions: Record<string, [string, string]>;
  updated: string[];
  installArgs: string[][];
  failAdd?: boolean;
  failInstall?: string;
  exec: (
    cmd: string,
    args: string[],
    opts?: { input?: string; timeoutMs?: number },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
};

// The fake claude replays what claude 2.1.322 printed (test/fixtures/claude-2.1.322).
const FX = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/claude-2.1.322",
);
const fx = (name: string) => JSON.parse(readFileSync(join(FX, name), "utf8"));
const fxText = (name: string) => readFileSync(join(FX, name), "utf8");
const line = (o: object, code = 0) => ({
  code,
  stdout: `${JSON.stringify(o)}\n`,
  stderr: "",
});
const bad = (failureCode: string, message: string) =>
  line({ command: "x", outcome: "failed", message, failureCode }, 1);

const fake = (over: Partial<Fake> = {}): Fake => {
  const f: Fake = {
    calls: [],
    inputs: [],
    version: "2.1.322",
    markets: [],
    installed: [],
    config: {},
    mcpList: "",
    versions: {},
    updated: [],
    installArgs: [],
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
        if (f.mcpList === "none")
          return { code: 1, stdout: "", stderr: fxText("mcp-get-missing.txt") };
        if (f.mcpList === "error")
          return { code: 2, stdout: "", stderr: "boom" };
        return { code: 0, stdout: f.mcpList, stderr: "" };
      }
      if (b === "marketplace" && d === "list")
        return {
          code: 0,
          stdout: `${JSON.stringify(
            f.markets.map((m) => ({
              installLocation: fx("list-markets.json")[0].installLocation,
              ...m,
            })),
            null,
            2,
          )}\n`,
          stderr: "",
        };
      if (b === "marketplace" && d === "add") {
        if (f.failAdd) return bad("clone_failed", "Clone failed");
        const src = args[3] as string;
        const [url, ref] = src.split("#");
        // Real claude 2.1.322: the same name from another source is refused.
        const was = f.markets[0];
        if (was && (was.url !== url || (was.ref ?? "") !== (ref ?? "")))
          return line(fx("add-other.json"), 1);
        f.markets = [
          {
            name: "open-artifacts",
            source: "git",
            url: url as string,
            ...(ref ? { ref } : {}),
          },
        ];
        return line(fx(was ? "add-same.json" : "add-fresh.json"));
      }
      if (b === "marketplace" && d === "remove") {
        if (!f.markets.length) return line(fx("remove-again.json"), 1);
        f.markets = [];
        f.installed = f.installed.filter((i) => !i.endsWith("@open-artifacts"));
        return line(fx("remove.json"));
      }
      if (b === "list")
        return {
          code: 0,
          stdout: `${JSON.stringify(
            f.installed.map((id) => ({ ...fx("list-plugins.json")[0], id })),
            null,
            2,
          )}\n`,
          stderr: "",
        };
      if (b === "install") {
        const id = d as string;
        if (f.failInstall === id) return bad("install_failed", "no");
        const already = f.installed.includes(id);
        if (!already) f.installed.push(id);
        f.installArgs.push(args);
        for (let i = 3; i < args.length; i++)
          if (args[i] === "--config") {
            const [k, ...v] = (args[i + 1] as string).split("=");
            f.config[k as string] = v.join("=");
          }
        const v = f.versions[id];
        // Real claude: a fresh install reports no versions, an installed one reports both.
        return line({
          ...fx(already ? "install-again.json" : "install-fresh.json"),
          plugin: id,
          pluginId: id,
          ...(already
            ? {
                installedVersion: v?.[0] ?? "1",
                availableVersion: v?.[1] ?? v?.[0] ?? "1",
              }
            : {}),
        });
      }
      if (b === "update") {
        const id = d as string;
        f.updated.push(id);
        const v = f.versions[id];
        if (v) f.versions[id] = [v[1], v[1]];
        return line({ ...fx("update.json"), plugin: id, pluginId: id });
      }
      if (b === "uninstall") {
        const id = args[2] as string;
        if (!f.installed.includes(id))
          return line(fx("uninstall-again.json"), 1);
        f.installed = f.installed.filter((i) => i !== id);
        return line({ ...fx("uninstall.json"), plugin: id, pluginId: id });
      }
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
const FOUND = fxText("mcp-get.txt").replace(
  "https://x.example.com/mcp",
  "https://oa.example.com/mcp",
);
const ELSEWHERE = fxText("mcp-get.txt");

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
    expect(f.config).toEqual({
      instanceUrl: `${ORIGIN}/mcp`,
      mcpServer: "open-artifacts",
    });
    expect(record(w.busHome)).toEqual({
      marketplace: true,
      plugins: [STYLE_PLUGIN, SHORTCUTS_PLUGIN],
    });
    // Every call went through exec with --json where it has one, nothing else.
    for (const call of f.calls) expect(call[0]).toBe("claude");
    expect(f.calls.some((x) => x.includes("--sparse"))).toBe(true);
  });

  it("uses open-artifacts with a note on a timeout, an error, no server, and another instance", async () => {
    const wording = {
      timeout: "in time",
      error: "Couldn't ask Claude Code",
      none: "Found no Claude Code MCP server",
    } as const;
    for (const [mcpList, text] of [
      ["timeout", wording.timeout],
      ["error", wording.error],
      ["none", wording.none],
      [ELSEWHERE, wording.none],
    ] as const) {
      const w = setup();
      const f = fake({ mcpList });
      const r = await run(f, w);
      expect(f.config.mcpServer).toBe("open-artifacts");
      expect(r.notes.join(" ")).toContain(text);
    }
  });

  it("asks about the one server, never the whole list", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND });
    await run(f, w);
    expect(f.calls.filter((x) => x[1] === "mcp")).toEqual([
      ["claude", "mcp", "get", "open-artifacts"],
    ]);
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
    f.config.mcpServer = "custom";
    f.mcpList = "timeout";
    await run(f, w);
    expect(f.config.mcpServer).toBe("custom");
  });

  it("moves to a new release: removes our marketplace, adds the new ref, reinstalls with the options", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND });
    await run(f, w, { version: "0.153.0" });
    expect(f.markets[0]).toMatchObject({ ref: "v0.153.0" });
    // Real claude refuses a re-add from another ref ("declared"); without the remove it fails.
    const r = await run(f, w, { version: "0.154.0" });
    expect(r.ok).toBe(true);
    expect(r.notes).toEqual([]);
    expect(f.markets[0]).toMatchObject({ ref: "v0.154.0" });
    expect(
      f.calls.some((x) => x[2] === "marketplace" && x[3] === "remove"),
    ).toBe(true);
    expect(f.installed.sort()).toEqual([SHORTCUTS_PLUGIN, STYLE_PLUGIN].sort());
    expect(f.config).toEqual({
      instanceUrl: `${ORIGIN}/mcp`,
      mcpServer: "open-artifacts",
    });
    expect(record(w.busHome)).toEqual({
      marketplace: true,
      plugins: [STYLE_PLUGIN, SHORTCUTS_PLUGIN],
    });
  });

  it("a same-ref rerun does not touch the marketplace", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND });
    await run(f, w);
    await run(f, w);
    expect(
      f.calls.filter(
        (x) => x[2] === "marketplace" && (x[3] === "add" || x[3] === "remove"),
      ),
    ).toHaveLength(1);
  });

  it("keeps the source, with a note, when another plugin from it is installed, and still updates ours", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND });
    await run(f, w, { version: "0.153.0" });
    f.installed.push("someone-else@open-artifacts");
    f.versions[STYLE_PLUGIN] = ["1", "2"];
    const r = await run(f, w, { version: "0.154.0" });
    expect(f.markets[0]).toMatchObject({ ref: "v0.153.0" });
    expect(f.calls.some((x) => x[3] === "remove")).toBe(false);
    expect(r.notes.join(" ")).toContain(
      "Kept the existing Open Artifacts plugin source at v0.153.0",
    );
    expect(f.updated).toEqual([STYLE_PLUGIN]);
    expect(f.installed).toContain("someone-else@open-artifacts");
  });

  it("keeps a marketplace we did not add, with a note", async () => {
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
    const r = await run(f, w);
    expect(f.calls.some((x) => x[3] === "remove" || x[3] === "add")).toBe(
      false,
    );
    expect(r.notes.join(" ")).toContain(
      "Kept the existing Open Artifacts plugin source",
    );
    expect(record(w.busHome).marketplace).toBe(false);
  });

  it("updates an installed plugin that has a newer version, then sets the options again", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND });
    await run(f, w);
    f.versions[SHORTCUTS_PLUGIN] = ["0.1.0", "0.2.0"];
    f.config = {};
    await run(f, w);
    expect(f.updated).toEqual([SHORTCUTS_PLUGIN]);
    expect(f.config.instanceUrl).toBe(`${ORIGIN}/mcp`);
    const u = f.calls.find((x) => x[2] === "update" || x[1] === "update");
    expect(u).toEqual([
      "claude",
      "plugin",
      "update",
      SHORTCUTS_PLUGIN,
      "--scope",
      "user",
      "--json",
    ]);
  });

  it("does not update when the versions match", async () => {
    const w = setup();
    const f = fake({
      mcpList: FOUND,
      versions: { [STYLE_PLUGIN]: ["1", "1"] },
    });
    await run(f, w);
    await run(f, w);
    expect(f.updated).toEqual([]);
  });

  it("records our marketplace when an add fails but it landed", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND });
    const orig = f.exec;
    f.exec = async (cmd, args, o) => {
      const r = await orig(cmd, args, o);
      return args[2] === "add" ? bad("timeout", "timed out") : r;
    };
    const r = await run(f, w);
    expect(r.notes.join(" ")).toContain("Couldn't add the plugin source");
    expect(record(w.busHome)).toEqual({ marketplace: true, plugins: [] });
  });

  it("skips instanceUrl with a note when the address does not parse", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND });
    const r = await run(f, w, { origin: "not a url" });
    expect(f.config).toEqual({});
    expect(f.calls.some((x) => x.join(" ").includes("not a url"))).toBe(false);
    expect(r.notes.join(" ")).toContain(
      "Couldn't read this instance's address",
    );
    expect(f.installed).toContain(SHORTCUTS_PLUGIN);
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
    expect(r.notes.join(" ")).toContain("Couldn't add the plugin source");
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
    // The record stays, so a later run finishes the job.
    expect(record(w2.busHome)).toBeDefined();
    f2.version = "2.1.322";
    f2.installed = [STYLE_PLUGIN, SHORTCUTS_PLUGIN];
    expect(
      (await uninstallClaudePlugins({ ...w2, exec: f2.exec, copy: c })).notes,
    ).toEqual([]);
    expect(record(w2.busHome)).toBeUndefined();
  });

  it("an uninstall that fails keeps the record, so a rerun finishes", async () => {
    const { w, f } = await withInstall();
    const orig = f.exec;
    f.exec = async (cmd, args, o) =>
      args[1] === "uninstall" && args[2] === STYLE_PLUGIN
        ? bad("boom", "boom")
        : orig(cmd, args, o);
    const r = await uninstallClaudePlugins({ ...w, exec: f.exec, copy: c });
    expect(r.notes.join(" ")).toContain("Couldn't remove");
    expect(record(w.busHome)).toBeDefined();
  });
});

const writeSettings = (home: string, o: object) => {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify(o));
};
const withUrl = (url: string) => ({
  pluginConfigs: { [SHORTCUTS_PLUGIN]: { options: { instanceUrl: url } } },
});

describe("claudePluginsState", () => {
  it("is undefined when we installed nothing, ok after an install, and names a plugin that went missing", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND });
    expect(await claudePluginsState({ ...w, exec: f.exec })).toBeUndefined();
    await run(f, w);
    writeSettings(w.home, withUrl(`${ORIGIN}/mcp`));
    expect(await claudePluginsState({ ...w, exec: f.exec })).toEqual({
      missing: [],
      unconfigured: false,
    });
    f.installed = [STYLE_PLUGIN];
    expect((await claudePluginsState({ ...w, exec: f.exec }))?.missing).toEqual(
      [SHORTCUTS_PLUGIN],
    );
    f.installed = [STYLE_PLUGIN, SHORTCUTS_PLUGIN];
    writeSettings(w.home, withUrl(""));
    expect(
      (await claudePluginsState({ ...w, exec: f.exec }))?.unconfigured,
    ).toBe(true);
  });

  it("is read-only: it never runs `plugin configure` or anything but list", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND });
    await run(f, w);
    writeSettings(w.home, withUrl(`${ORIGIN}/mcp`));
    f.calls.length = 0;
    await claudePluginsState({ ...w, exec: f.exec });
    expect(f.calls).toEqual([["claude", "plugin", "list", "--json"]]);
  });

  it("reads the options from settings.json: none without the file is no finding, none in a present file is", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND });
    await run(f, w);
    rmSync(join(w.home, ".claude/settings.json"), { force: true });
    expect(
      (await claudePluginsState({ ...w, exec: f.exec }))?.unconfigured,
    ).toBe(false);
    writeSettings(w.home, {});
    expect(
      (await claudePluginsState({ ...w, exec: f.exec }))?.unconfigured,
    ).toBe(true);
  });
});

describe("review fixes", () => {
  it("uninstall does not remove a marketplace of the same name that is no longer ours", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND });
    await run(f, w);
    f.markets = [{ name: "open-artifacts", source: "directory", path: "/x" }];
    await uninstallClaudePlugins({ ...w, exec: f.exec, copy: c });
    expect(f.calls.some((x) => x[3] === "remove")).toBe(false);
    expect(f.markets).toHaveLength(1);
    expect(record(w.busHome)).toBeUndefined();
  });

  it("install on a foreign marketplace clears marketplace:true from the record", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND });
    await run(f, w);
    f.markets = [{ name: "open-artifacts", source: "directory", path: "/x" }];
    await run(f, w);
    expect(record(w.busHome)).toEqual({
      marketplace: false,
      plugins: [STYLE_PLUGIN, SHORTCUTS_PLUGIN],
    });
  });

  it("passes --config only to a shortcuts plugin we installed, never to the person's own", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND, installed: [SHORTCUTS_PLUGIN] });
    await run(f, w);
    expect(f.installArgs.some((a) => a.includes("--config"))).toBe(false);
    expect(f.config).toEqual({});
    expect(record(w.busHome).plugins).toEqual([STYLE_PLUGIN]);
    // And once it is ours (recorded), a rerun keeps setting it.
    const w2 = setup();
    const f2 = fake({ mcpList: FOUND });
    await run(f2, w2);
    f2.installArgs.length = 0;
    await run(f2, w2);
    expect(f2.installArgs.some((a) => a.includes("--config"))).toBe(true);
  });

  it("a failed marketplace remove keeps the record so a rerun retries", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND });
    await run(f, w);
    const orig = f.exec;
    f.exec = async (cmd, args, o) =>
      args[1] === "marketplace" && args[2] === "remove"
        ? bad("boom", "boom")
        : orig(cmd, args, o);
    const r = await uninstallClaudePlugins({ ...w, exec: f.exec, copy: c });
    expect(r.notes.join(" ")).toContain("Couldn't remove");
    expect(record(w.busHome)).toBeDefined();
    f.exec = orig;
    f.installed = [];
    await uninstallClaudePlugins({ ...w, exec: f.exec, copy: c });
    expect(f.markets).toEqual([]);
    expect(record(w.busHome)).toBeUndefined();
  });

  it("parses the real multi-line list output", async () => {
    const w = setup();
    const f = fake({ mcpList: FOUND });
    await run(f, w);
    const out = await f.exec("claude", ["plugin", "list", "--json"]);
    expect(out.stdout.trim().split("\n").length).toBeGreaterThan(3);
    expect((await run(f, w)).ok).toBe(true);
  });
});
