import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsoncValue } from "@oa/bus-adapter-mcp-json";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AdapterDeps,
  checkAdapters,
  type Exec,
  installAdapters,
  ompAgentDir,
  readAssets,
  uninstallAdapters,
} from "../src/steps/adapters.ts";

const BIN = "/usr/local/bin/oa-bus";

type Call = string[];
type Reply = { code: number; stdout?: string; stderr?: string };

/** A fake exec: records every call; replies per "cmd sub" key, default ok. */
function fakeExec(replies: Record<string, Reply | Error> = {}) {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = [cmd, ...args].join(" ");
    const hit = Object.entries(replies).find(([k]) => key.startsWith(k))?.[1];
    if (hit instanceof Error) throw hit;
    if (hit) return { stdout: "", stderr: "", ...hit };
    if (key === "opencode --version")
      return { code: 0, stdout: "opencode v2.0.32\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, exec };
}

function setup(present: string[] = ["claude", "opencode", "pi"]) {
  const h = mkdtempSync(join(tmpdir(), "ob-inst-"));
  const fake = fakeExec();
  const deps: AdapterDeps = {
    home: h,
    env: {},
    busBin: [BIN],
    assets: { pi: "PI_ASSET", opencodePlugin: "PLUGIN_JS" },
    which: (cmd) => present.includes(cmd),
    exec: fake.exec,
  };
  return { h, deps, calls: fake.calls };
}

const p = {
  claude: (h: string) => join(h, ".claude.json"),
  oc: (h: string) => join(h, ".config/opencode/opencode.json"),
  cli: (h: string) => join(h, ".config/opencode/cli.json"),
  plugin: (h: string) => join(h, ".oa-bus/integrations/opencode/oa_bus"),
  pi: (h: string) => join(h, ".pi/agent/extensions/oa-bus.ts"),
};
const readJ = (path: string) => JSON.parse(readFileSync(path, "utf8"));
type Json = { mcp: { servers: Record<string, unknown> } };
const jparse = (text: string) => jsoncValue(text, []) as Json;
const put = (path: string, data: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
};

const CLAUDE_ADD = [
  "claude",
  "mcp",
  "add",
  "--scope",
  "user",
  "oa_bus",
  "--",
  BIN,
  "mcp",
  "claude",
];
const CLAUDE_RM = ["claude", "mcp", "remove", "--scope", "user", "oa_bus"];
const OC_RESTART = ["opencode", "service", "restart"];

describe("installAdapters", () => {
  it("runs a [node, entry] argv: Claude's add, its file fallback, OpenCode", async () => {
    const argv = ["/opt/node/bin/node", "/h/.oa-bus/bin/oa-bus.js"];
    const { h, deps, calls } = setup(["claude", "opencode"]);
    deps.busBin = argv;
    await installAdapters(deps);
    expect(calls).toContainEqual([
      ...CLAUDE_ADD.slice(0, 7),
      ...argv,
      "mcp",
      "claude",
    ]);
    expect(readJ(p.oc(h)).mcp.servers.oa_bus.command).toEqual([
      ...argv,
      "mcp",
      "opencode",
    ]);
    deps.exec = fakeExec({ "claude mcp add": { code: 1, stderr: "no" } }).exec;
    put(p.claude(h), {});
    await installAdapters(deps);
    expect(readJ(p.claude(h)).mcpServers.oa_bus).toMatchObject({
      command: argv[0],
      args: [argv[1], "mcp", "claude"],
    });
  });

  it("installs into every harness present", async () => {
    const { h, deps, calls } = setup();
    put(p.oc(h), {
      $schema: "x",
      mcp: { servers: { other: { type: "remote", url: "u" } } },
    });
    put(p.cli(h), { plugins: ["./herdr"], scroll: { acceleration: false } });

    const out = await installAdapters(deps);

    expect(out.installed).toEqual(["claude", "opencode", "pi"]);
    expect(out.skipped).toEqual([]);
    // Claude: through its CLI (replace = remove then add), never the file.
    expect(calls).toContainEqual(CLAUDE_RM);
    expect(calls).toContainEqual(CLAUDE_ADD);
    expect(calls.findIndex((c) => c.join() === CLAUDE_RM.join())).toBeLessThan(
      calls.findIndex((c) => c.join() === CLAUDE_ADD.join()),
    );
    expect(existsSync(p.claude(h))).toBe(false);

    expect(readJ(p.oc(h))).toEqual({
      $schema: "x",
      mcp: {
        servers: {
          other: { type: "remote", url: "u" },
          oa_bus: { type: "local", command: [BIN, "mcp", "opencode"] },
        },
      },
    });
    expect(readJ(p.cli(h))).toEqual({
      plugins: ["./herdr", p.plugin(h)],
      scroll: { acceleration: false },
    });
    expect(readFileSync(join(p.plugin(h), "tui.js"), "utf8")).toBe("PLUGIN_JS");
    expect(calls).toContainEqual(OC_RESTART);

    expect(readFileSync(p.pi(h), "utf8")).toBe("PI_ASSET");
    expect(statSync(p.pi(h)).mode & 0o777).toBe(0o644);
    // No temp files left behind.
    expect(readdirSync(join(h, ".config/opencode")).sort()).toEqual([
      "cli.json",
      "opencode.json",
    ]);
  });

  it("skips absent harnesses and touches nothing of theirs", async () => {
    const { h, deps, calls } = setup(["pi"]);
    const out = await installAdapters(deps);
    expect(out.installed).toEqual(["pi"]);
    expect(out.absent).toEqual(["claude", "opencode", "omp", "codex"]);
    expect(calls).toEqual([]);
    expect(existsSync(join(h, ".config"))).toBe(false);
    expect(existsSync(join(h, ".oa-bus"))).toBe(false);
  });

  it("creates the opencode files when missing", async () => {
    const { h, deps } = setup(["opencode"]);
    await installAdapters(deps);
    expect(readJ(p.oc(h))).toEqual({
      mcp: {
        servers: {
          oa_bus: { type: "local", command: [BIN, "mcp", "opencode"] },
        },
      },
    });
    expect(readJ(p.cli(h))).toEqual({ plugins: [p.plugin(h)] });
  });

  it("is idempotent", async () => {
    const { h, deps, calls } = setup(["opencode", "pi"]);
    put(p.cli(h), { plugins: ["./a"] });
    await installAdapters(deps);
    const oc = readFileSync(p.oc(h), "utf8");
    const cli = readFileSync(p.cli(h), "utf8");
    const again = await installAdapters(deps);
    expect(again.installed).toEqual(["opencode", "pi"]);
    expect(readFileSync(p.oc(h), "utf8")).toBe(oc);
    expect(readFileSync(p.cli(h), "utf8")).toBe(cli);
    expect(readJ(p.cli(h)).plugins).toEqual(["./a", p.plugin(h)]);
    expect(calls.filter((c) => c.join() === OC_RESTART.join())).toHaveLength(2);
  });

  it("honours XDG_CONFIG_HOME, OPENCODE_CONFIG_DIR, PI_CODING_AGENT_DIR and busHome", async () => {
    const { h, deps } = setup(["opencode", "pi"]);
    deps.env = {
      OPENCODE_CONFIG_DIR: join(h, "oc"),
      PI_CODING_AGENT_DIR: join(h, "pa"),
    };
    deps.busHome = join(h, "obh");
    await installAdapters(deps);
    expect(readJ(join(h, "oc/cli.json")).plugins).toEqual([
      join(h, "obh/integrations/opencode/oa_bus"),
    ]);
    expect(existsSync(join(h, "obh/integrations/opencode/oa_bus/tui.js"))).toBe(
      true,
    );
    expect(existsSync(join(h, "pa/extensions/oa-bus.ts"))).toBe(true);

    const x = setup(["opencode"]);
    x.deps.env = { XDG_CONFIG_HOME: join(x.h, "xdg") };
    await installAdapters(x.deps);
    expect(existsSync(join(x.h, "xdg/opencode/opencode.json"))).toBe(true);
  });

  it("leaves a malformed opencode config untouched and skips opencode", async () => {
    const { h, deps, calls } = setup(["opencode", "pi"]);
    put(p.oc(h), "{ not json");
    put(p.cli(h), { plugins: [] });
    const out = await installAdapters(deps);
    expect(out.installed).toEqual(["pi"]);
    expect(out.skipped).toEqual([
      { harness: "opencode", reason: expect.stringContaining("opencode.json") },
    ]);
    expect(readFileSync(p.oc(h), "utf8")).toBe("{ not json");
    expect(readJ(p.cli(h))).toEqual({ plugins: [] });
    expect(existsSync(p.plugin(h))).toBe(false);
    expect(calls).not.toContainEqual(OC_RESTART);
  });

  it("treats a JSON array or a non-object mcp as malformed", async () => {
    const { h, deps } = setup(["opencode"]);
    put(p.cli(h), "[]");
    expect((await installAdapters(deps)).skipped[0]?.reason).toContain(
      "cli.json",
    );
    expect(readFileSync(p.cli(h), "utf8")).toBe("[]");

    const y = setup(["opencode"]);
    put(p.oc(y.h), { mcp: "nope" });
    expect((await installAdapters(y.deps)).skipped[0]?.harness).toBe(
      "opencode",
    );
    expect(readJ(p.oc(y.h))).toEqual({ mcp: "nope" });
  });

  it("skips OpenCode older than v2", async () => {
    const { h, deps } = setup(["opencode"]);
    deps.exec = fakeExec({
      "opencode --version": { code: 0, stdout: "1.19.4" },
    }).exec;
    const out = await installAdapters(deps);
    expect(out.skipped).toEqual([
      { harness: "opencode", reason: expect.stringMatching(/v2.*1\.19\.4/) },
    ]);
    expect(existsSync(join(h, ".config"))).toBe(false);
  });

  it("reports a failed opencode restart without failing the install", async () => {
    const { deps } = setup(["opencode"]);
    deps.exec = fakeExec({
      "opencode service restart": { code: 1, stderr: "no service\n" },
    }).exec;
    const out = await installAdapters(deps);
    expect(out.installed).toEqual(["opencode"]);
    expect(out.notes.join("\n")).toMatch(
      /opencode service restart.*no service/,
    );
  });

  it("falls back to an atomic ~/.claude.json edit when the claude CLI fails", async () => {
    const { h, deps } = setup(["claude"]);
    put(p.claude(h), {
      theme: "dark",
      mcpServers: { other: { command: "x" } },
      projects: {},
    });
    deps.exec = fakeExec({
      "claude mcp add": { code: 1, stderr: "boom\n" },
    }).exec;
    const out = await installAdapters(deps);
    expect(out.installed).toEqual(["claude"]);
    expect(out.notes.join("\n")).toMatch(
      /claude mcp add failed.*boom.*\.claude\.json/,
    );
    expect(readJ(p.claude(h))).toEqual({
      theme: "dark",
      projects: {},
      mcpServers: {
        other: { command: "x" },
        oa_bus: {
          type: "stdio",
          command: BIN,
          args: ["mcp", "claude"],
          env: {},
        },
      },
    });
    // Twice is still one entry.
    await installAdapters(deps);
    expect(Object.keys(readJ(p.claude(h)).mcpServers)).toEqual([
      "other",
      "oa_bus",
    ]);
  });

  it("falls back when exec throws, honours CLAUDE_CONFIG_DIR and keeps the file mode", async () => {
    const { h, deps } = setup(["claude"]);
    deps.env = { CLAUDE_CONFIG_DIR: join(h, "cc") };
    deps.exec = fakeExec({ claude: new Error("spawn EACCES") }).exec;
    const path = join(h, "cc/.claude.json");
    put(path, {});
    const { chmodSync } = await import("node:fs");
    chmodSync(path, 0o600);
    await installAdapters(deps);
    expect(readJ(path).mcpServers.oa_bus.command).toBe(BIN);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("does not fall back onto a malformed ~/.claude.json", async () => {
    const { h, deps } = setup(["claude"]);
    put(p.claude(h), "{oops");
    deps.exec = fakeExec({ "claude mcp add": { code: 1 } }).exec;
    const out = await installAdapters(deps);
    expect(out.installed).toEqual([]);
    expect(out.skipped[0]).toEqual({
      harness: "claude",
      reason: expect.stringContaining(".claude.json"),
    });
    expect(readFileSync(p.claude(h), "utf8")).toBe("{oops");
  });

  it("writes through a symlinked config instead of replacing the link", async () => {
    const { h, deps } = setup(["opencode"]);
    const real = join(h, "dotfiles/opencode.json");
    put(real, { a: 1 });
    mkdirSync(join(h, ".config/opencode"), { recursive: true });
    symlinkSync(real, p.oc(h));
    await installAdapters(deps);
    expect(readJ(real).mcp.servers.oa_bus).toBeDefined();
    expect(statSync(p.oc(h)).isFile()).toBe(true);
    const { lstatSync } = await import("node:fs");
    expect(lstatSync(p.oc(h)).isSymbolicLink()).toBe(true);
  });
});

describe("uninstallAdapters", () => {
  it("removes exactly our entries and leaves the rest", async () => {
    const { h, deps, calls } = setup();
    put(p.oc(h), {
      $schema: "x",
      mcp: { servers: { other: { type: "remote", url: "u" } } },
    });
    put(p.cli(h), { plugins: ["./herdr"] });
    put(join(h, ".pi/agent/extensions/mine.ts"), "MINE");
    await installAdapters(deps);
    calls.length = 0;

    const out = await uninstallAdapters(deps);

    expect(out.removed).toEqual(["claude", "opencode", "pi"]);
    expect(calls).toContainEqual(CLAUDE_RM);
    expect(calls).toContainEqual(OC_RESTART);
    expect(readJ(p.oc(h))).toEqual({
      $schema: "x",
      mcp: { servers: { other: { type: "remote", url: "u" } } },
    });
    expect(readJ(p.cli(h))).toEqual({ plugins: ["./herdr"] });
    expect(existsSync(p.plugin(h))).toBe(false);
    expect(existsSync(p.pi(h))).toBe(false);
    expect(readFileSync(join(h, ".pi/agent/extensions/mine.ts"), "utf8")).toBe(
      "MINE",
    );
  });

  it("removes a file-written claude entry when the CLI cannot", async () => {
    const { h, deps } = setup(["claude"]);
    put(p.claude(h), {
      theme: "dark",
      mcpServers: { oa_bus: { command: BIN }, other: { command: "x" } },
    });
    deps.exec = fakeExec({
      "claude mcp remove": { code: 1, stderr: "nope" },
    }).exec;
    const out = await uninstallAdapters(deps);
    expect(out.removed).toEqual(["claude"]);
    expect(readJ(p.claude(h))).toEqual({
      theme: "dark",
      mcpServers: { other: { command: "x" } },
    });
  });

  it("cleans our opencode and pi files even when the binaries are gone", async () => {
    const { h, deps } = setup();
    await installAdapters(deps);
    const gone = { ...deps, which: () => false, exec: fakeExec().exec };
    const out = await uninstallAdapters(gone);
    expect(out.removed).toEqual(["opencode", "pi"]);
    // Install created mcp.servers, so uninstall drops it once empty.
    expect(readJ(p.oc(h))).toEqual({});
  });

  it("reports nothing when nothing of ours is there", async () => {
    const { h, deps, calls } = setup(["opencode", "pi"]);
    put(p.oc(h), { mcp: { servers: { other: {} } } });
    const before = readFileSync(p.oc(h), "utf8");
    const out = await uninstallAdapters(deps);
    expect(out.removed).toEqual([]);
    expect(readFileSync(p.oc(h), "utf8")).toBe(before);
    expect(existsSync(p.cli(h))).toBe(false);
    expect(calls).not.toContainEqual(OC_RESTART);
  });

  it("leaves a malformed config untouched", async () => {
    const { h, deps } = setup(["opencode"]);
    await installAdapters(deps);
    put(p.cli(h), "// comment\n{ nope");
    const out = await uninstallAdapters(deps);
    expect(out.skipped).toEqual([
      { harness: "opencode", reason: expect.stringContaining("cli.json") },
    ]);
    expect(readFileSync(p.cli(h), "utf8")).toBe("// comment\n{ nope");
    expect(readJ(p.oc(h)).mcp.servers.oa_bus).toBeDefined();
  });
});

describe("JSONC opencode configs", () => {
  // The shape of a real OpenCode 2.0.32 config: comments, trailing commas.
  const CONFIG = `{
  // my config
  "$schema": "https://opencode.ai/config.json",
  /* server plugins */
  "plugins": ["./server-plugin",],
  "mcp": {
    "servers": {
      // keep me
      "other": { "type": "local", "command": ["x"], },
    },
  },
}
`;
  const CLI = `{
  // TUI plugins
  "plugins": [
    "./herdr", // note
  ],
}
`;
  const comments = [
    "// my config",
    "/* server plugins */",
    "// keep me",
    "// TUI plugins",
    "// note",
  ];

  it("installs without losing a comment, and uninstall restores the text", async () => {
    const { h, deps } = setup(["opencode"]);
    put(p.oc(h), CONFIG);
    put(p.cli(h), CLI);

    const out = await installAdapters(deps);
    expect(out.installed).toEqual(["opencode"]);
    const oc = readFileSync(p.oc(h), "utf8");
    const cli = readFileSync(p.cli(h), "utf8");
    for (const c of comments) expect(oc + cli).toContain(c);
    expect(oc).toContain('"plugins": ["./server-plugin",],');
    expect(oc).toContain('"other": { "type": "local", "command": ["x"], },');
    expect(oc).toMatch(/"oa_bus": \{/);
    expect(cli).toContain(JSON.stringify(p.plugin(h)));

    expect(await installAdapters(deps)).toMatchObject({ skipped: [] });
    expect(readFileSync(p.oc(h), "utf8")).toBe(oc);
    expect(readFileSync(p.cli(h), "utf8")).toBe(cli);

    expect((await uninstallAdapters(deps)).removed).toEqual(["opencode"]);
    expect(readFileSync(p.oc(h), "utf8")).toBe(CONFIG);
    expect(readFileSync(p.cli(h), "utf8")).toBe(CLI);
  });
});

describe("never corrupts or strips a config", () => {
  const writable: string[] = [];
  afterEach(() => {
    for (const d of writable.splice(0)) chmodSync(d, 0o755);
  });
  const ocDir = (h: string) => join(h, ".config/opencode");

  it("a failed uninstall save leaves the plugin folder cli.json points at", async () => {
    const { h, deps } = setup(["opencode"]);
    await installAdapters(deps);
    chmodSync(ocDir(h), 0o555);
    writable.push(ocDir(h));
    const out = await uninstallAdapters(deps);
    expect(out.skipped.map((x) => x.harness)).toEqual(["opencode"]);
    expect(readFileSync(p.cli(h), "utf8")).toContain(p.plugin(h));
    expect(existsSync(join(p.plugin(h), "tui.js"))).toBe(true);
  });

  it("never replaces a dangling symlinked config with a regular file", async () => {
    const { h, deps } = setup(["opencode"]);
    mkdirSync(ocDir(h), { recursive: true });
    symlinkSync(join(h, "dotfiles/opencode.json"), p.oc(h));
    const out = await installAdapters(deps);
    expect(out.skipped).toEqual([
      { harness: "opencode", reason: expect.stringContaining("symlink") },
    ]);
    expect(lstatSync(p.oc(h)).isSymbolicLink()).toBe(true);
    expect(existsSync(p.cli(h))).toBe(false);
    expect(existsSync(p.plugin(h))).toBe(false);
  });

  it("writes through a dangling symlink whose target directory exists", async () => {
    const { h, deps } = setup(["opencode"]);
    mkdirSync(ocDir(h), { recursive: true });
    mkdirSync(join(h, "dotfiles"));
    symlinkSync(join(h, "dotfiles/opencode.json"), p.oc(h));
    await installAdapters(deps);
    expect(lstatSync(p.oc(h)).isSymbolicLink()).toBe(true);
    expect(
      readJ(join(h, "dotfiles/opencode.json")).mcp.servers.oa_bus,
    ).toBeDefined();
  });

  it.each([
    ["no output", { code: 1, stderr: "boom" }],
    ["a runtime's version only", { code: 0, stdout: "bun 1.2.19\n" }],
  ])(
    "skips OpenCode with an unreadable version (%s), writing nothing",
    async (_, reply) => {
      const { h, deps } = setup(["opencode"]);
      deps.exec = fakeExec({ "opencode --version": reply }).exec;
      const v1 =
        '{\n  "mcp": {\n    "github": { "type": "remote", "url": "u" }\n  }\n}\n';
      put(p.oc(h), v1);
      const out = await installAdapters(deps);
      expect(out.skipped).toEqual([
        { harness: "opencode", reason: expect.stringMatching(/version/i) },
      ]);
      expect(readFileSync(p.oc(h), "utf8")).toBe(v1);
      expect(existsSync(p.cli(h))).toBe(false);
    },
  );

  it("does not trust a version on a later line, after a wrapper's banner", async () => {
    const { deps } = setup(["opencode"]);
    deps.exec = fakeExec({
      "opencode --version": {
        code: 0,
        stdout: "bun 1.2.19\nopencode v2.0.32\n",
      },
    }).exec;
    expect((await installAdapters(deps)).skipped).toEqual([
      { harness: "opencode", reason: expect.stringMatching(/version/i) },
    ]);
  });

  it("refuses a null plugins list and leaves both files untouched", async () => {
    const { h, deps } = setup(["opencode"]);
    put(p.oc(h), "{}\n");
    put(p.cli(h), '{\n  "plugins": null\n}\n');
    const out = await installAdapters(deps);
    expect(out.skipped[0]).toMatchObject({ harness: "opencode" });
    expect(readFileSync(p.cli(h), "utf8")).toBe('{\n  "plugins": null\n}\n');
    expect(readFileSync(p.oc(h), "utf8")).toBe("{}\n");
  });

  it("install then uninstall restores configs without mcp or plugins byte for byte", async () => {
    const { h, deps } = setup(["opencode"]);
    const oc = '{\n  // mine\n  "theme": "x",\n}\n';
    const cli = '{\n  "scroll": { "speed": 2 }\n}\n';
    put(p.oc(h), oc);
    put(p.cli(h), cli);
    await installAdapters(deps);
    await installAdapters(deps);
    expect(readJ(join(h, ".oa-bus/install.json"))).toBeDefined();
    await uninstallAdapters(deps);
    expect(readFileSync(p.oc(h), "utf8")).toBe(oc);
    expect(readFileSync(p.cli(h), "utf8")).toBe(cli);
  });

  it("leaves a container it did not create, even when empty", async () => {
    const { h, deps } = setup(["opencode"]);
    const oc = '{\n  "mcp": {\n    "servers": {}\n  }\n}\n';
    put(p.oc(h), oc);
    await installAdapters(deps);
    await uninstallAdapters(deps);
    expect(readFileSync(p.oc(h), "utf8")).toBe(oc);
  });

  it("edits opencode.jsonc when it is the only config, and cleans it on uninstall", async () => {
    const { h, deps } = setup(["opencode"]);
    const jsonc = join(ocDir(h), "opencode.jsonc");
    const text = '{\n  // jsonc user\n  "mcp": { "servers": {} }\n}\n';
    put(jsonc, text);
    await installAdapters(deps);
    expect(existsSync(p.oc(h))).toBe(false);
    expect(readFileSync(jsonc, "utf8")).toContain('"oa_bus"');
    expect(readFileSync(jsonc, "utf8")).toContain("// jsonc user");
    await uninstallAdapters(deps);
    expect(readFileSync(jsonc, "utf8")).toBe(text);
  });
});

describe("containers and files the user touched", () => {
  it("a comment the user adds inside a container we created survives uninstall", async () => {
    const { h, deps } = setup(["opencode"]);
    const oc = (x: string) => join(x, ".config/opencode");
    await installAdapters(deps);
    const cliPath = join(oc(h), "cli.json");
    const cli = readFileSync(cliPath, "utf8").replace(
      "[",
      "[\n    // TODO add my theme plugin here",
    );
    writeFileSync(cliPath, cli);
    await uninstallAdapters(deps);
    expect(readFileSync(cliPath, "utf8")).toContain(
      "// TODO add my theme plugin here",
    );
  });

  it("an entry the user adds to a container we created survives uninstall", async () => {
    const { h, deps } = setup(["opencode"]);
    const oc = (x: string) => join(x, ".config/opencode");
    await installAdapters(deps);
    const cfg = join(oc(h), "opencode.json");
    const t = readFileSync(cfg, "utf8").replace(
      '"servers": {',
      '"servers": {\n      "mine": {"type":"local","command":["m"]},',
    );
    writeFileSync(cfg, t);
    await uninstallAdapters(deps);
    expect(jparse(readFileSync(cfg, "utf8")).mcp.servers).toEqual({
      mine: { type: "local", command: ["m"] },
    });
  });

  it("corrupt install.json: uninstall still removes our entries", async () => {
    const { h, deps } = setup(["opencode"]);
    const oc = (x: string) => join(x, ".config/opencode");
    await installAdapters(deps);
    writeFileSync(join(h, ".oa-bus/install.json"), "{nope");
    const r = await uninstallAdapters(deps);
    expect(r.removed).toContain("opencode");
    expect(readFileSync(join(oc(h), "cli.json"), "utf8")).not.toContain(
      p.plugin(h),
    );
  });

  it("opencode.jsonc is edited in place, no opencode.json created", async () => {
    const { h, deps } = setup(["opencode"]);
    const oc = (x: string) => join(x, ".config/opencode");
    mkdirSync(oc(h), { recursive: true });
    writeFileSync(
      join(oc(h), "opencode.jsonc"),
      '{\n  // mine\n  "theme": "x",\n}\n',
    );
    await installAdapters(deps);
    expect(existsSync(join(oc(h), "opencode.json"))).toBe(false);
    await uninstallAdapters(deps);
    expect(readFileSync(join(oc(h), "opencode.jsonc"), "utf8")).toBe(
      '{\n  // mine\n  "theme": "x",\n}\n',
    );
  });

  it("dangling symlink whose target dir exists is written through", async () => {
    const { h, deps } = setup(["opencode"]);
    const oc = (x: string) => join(x, ".config/opencode");
    mkdirSync(oc(h), { recursive: true });
    mkdirSync(join(h, "dot"));
    symlinkSync("../../dot/opencode.json", join(oc(h), "opencode.json"));
    await installAdapters(deps);
    expect(lstatSync(join(oc(h), "opencode.json")).isSymbolicLink()).toBe(true);
    expect(
      jparse(readFileSync(join(h, "dot/opencode.json"), "utf8")).mcp.servers
        .oa_bus,
    ).toBeDefined();
  });
});

describe("readAssets", () => {
  it("reads the shipped Pi extension and OpenCode TUI plugin", () => {
    const a = readAssets();
    expect(a.pi).toContain("Open Artifacts bus");
    expect(a.opencodePlugin).toContain(
      "Open Artifacts bus OpenCode TUI plugin",
    );
  });
});

describe("oh-my-pi (C23b)", () => {
  const omp = (h: string) => join(h, ".omp/agent/extensions/oa-bus.ts");

  it.each([
    ["omp on PATH", (_h: string) => {}, ["omp"]],
    ["~/.omp", (h: string) => mkdirSync(join(h, ".omp")), []],
    ["~/.bun/bin/omp", (h: string) => put(join(h, ".bun/bin/omp"), ""), []],
  ])("is found by %s, installed, checked and removed", async (_, make, on) => {
    const { h, deps, calls } = setup(on);
    make(h);
    const out = await installAdapters(deps);
    expect(out.installed).toEqual(["omp"]);
    expect(out.sharedPiFile).toBeUndefined();
    expect(readFileSync(omp(h), "utf8")).toBe("PI_ASSET");
    expect(existsSync(p.pi(h))).toBe(false);
    expect(calls).toEqual([]);
    expect(checkAdapters(deps).omp).toBe("configured");
    expect((await uninstallAdapters(deps)).removed).toEqual(["omp"]);
    expect(existsSync(omp(h))).toBe(false);
    expect(checkAdapters(deps).omp).toBe("missing");
  });

  it("is absent with no binary and no ~/.omp", async () => {
    const { h, deps } = setup(["pi"]);
    const out = await installAdapters(deps);
    expect(out.absent).toContain("omp");
    expect(existsSync(join(h, ".omp"))).toBe(false);
    expect(checkAdapters(deps).omp).toBe("absent");
  });

  it("installs beside Pi: the same file in each folder", async () => {
    const { h, deps } = setup(["pi", "omp"]);
    const out = await installAdapters(deps);
    expect(out.installed).toEqual(["pi", "omp"]);
    expect(out.sharedPiFile).toBeUndefined();
    expect(readFileSync(p.pi(h), "utf8")).toBe("PI_ASSET");
    expect(readFileSync(omp(h), "utf8")).toBe("PI_ASSET");
  });

  it("PI_CODING_AGENT_DIR without Pi: omp's file goes there", async () => {
    const { h, deps } = setup(["omp"]);
    deps.env = { PI_CODING_AGENT_DIR: join(h, "agent") };
    const out = await installAdapters(deps);
    expect(out.sharedPiFile).toBeUndefined();
    expect(readFileSync(join(h, "agent/extensions/oa-bus.ts"), "utf8")).toBe(
      "PI_ASSET",
    );
  });

  it("a PI_CODING_AGENT_DIR shared with Pi is written once and said so; uninstall reports both", async () => {
    const { h, deps } = setup(["pi", "omp"]);
    const file = join(h, "agent/extensions/oa-bus.ts");
    deps.env = { PI_CODING_AGENT_DIR: join(h, "agent") };
    const out = await installAdapters(deps);
    expect(out.installed).toEqual(["pi", "omp"]);
    expect(out.sharedPiFile).toBe(file);
    expect(readFileSync(file, "utf8")).toBe("PI_ASSET");
    expect(existsSync(omp(h))).toBe(false);
    expect(checkAdapters(deps)).toMatchObject({
      pi: "configured",
      omp: "configured",
    });
    const gone = await uninstallAdapters(deps);
    expect(gone.removed).toEqual(["pi", "omp"]);
    expect(existsSync(file)).toBe(false);
  });

  it("a relative PI_CODING_AGENT_DIR is one shared folder for both", async () => {
    const { h, deps } = setup(["pi", "omp"]);
    const cwd = process.cwd();
    process.chdir(h);
    try {
      deps.env = { PI_CODING_AGENT_DIR: "agent" };
      const file = join(realpathSync(h), "agent/extensions/oa-bus.ts");
      const out = await installAdapters(deps);
      expect(out.sharedPiFile).toBe(file);
      expect(existsSync(file)).toBe(true);
      expect((await uninstallAdapters(deps)).removed).toEqual(["pi", "omp"]);
      expect(existsSync(file)).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });

  it("a shared file Pi's step could not write is not counted as installed for omp", async () => {
    const { h, deps } = setup(["pi", "omp"]);
    const file = join(h, "agent/extensions/oa-bus.ts");
    deps.env = { PI_CODING_AGENT_DIR: join(h, "agent") };
    // Something already there that a write cannot replace.
    mkdirSync(join(file, "x"), { recursive: true });
    const out = await installAdapters(deps);
    expect(out.installed).toEqual([]);
    expect(out.skipped.map((s) => s.harness)).toEqual(["pi", "omp"]);
    expect(out.sharedPiFile).toBeUndefined();
  });

  it("follows OMP_PROFILE and PI_CONFIG_DIR as omp does", async () => {
    const { h, deps } = setup([]);
    mkdirSync(join(h, ".omp-alt"));
    deps.env = { PI_CONFIG_DIR: ".omp-alt", OMP_PROFILE: "work" };
    const out = await installAdapters(deps);
    expect(out.installed).toEqual(["omp"]);
    expect(
      existsSync(join(h, ".omp-alt/profiles/work/agent/extensions/oa-bus.ts")),
    ).toBe(true);
    expect(checkAdapters(deps).omp).toBe("configured");
  });
});

describe("ompAgentDir: omp's pi-utils dirs.ts rules", () => {
  const h = "/home/u";
  it.each([
    [{}, "/home/u/.omp/agent"],
    [{ PI_CONFIG_DIR: ".alt" }, "/home/u/.alt/agent"],
    [{ PI_CODING_AGENT_DIR: "/x/agent" }, "/x/agent"],
    [{ PI_CODING_AGENT_DIR: "~/a" }, "/home/u/a"],
    [{ OMP_PROFILE: "work" }, "/home/u/.omp/profiles/work/agent"],
    [{ PI_PROFILE: "work" }, "/home/u/.omp/profiles/work/agent"],
    [{ OMP_PROFILE: "a", PI_PROFILE: "b" }, "/home/u/.omp/profiles/a/agent"],
    // A named profile ignores PI_CODING_AGENT_DIR.
    [
      { OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/x/agent" },
      "/home/u/.omp/profiles/work/agent",
    ],
    // An empty OMP_PROFILE is the default profile, not PI_PROFILE's.
    [{ OMP_PROFILE: "", PI_PROFILE: "work" }, "/home/u/.omp/agent"],
    // ...and then PI_PROFILE's own dir in PI_CODING_AGENT_DIR is not an override.
    [
      {
        OMP_PROFILE: "",
        PI_PROFILE: "work",
        PI_CODING_AGENT_DIR: "/home/u/.omp/profiles/work/agent",
      },
      "/home/u/.omp/agent",
    ],
    [{ OMP_PROFILE: "default" }, "/home/u/.omp/agent"],
    [{ OMP_PROFILE: "Bad Name" }, "/home/u/.omp/agent"],
  ])("%j -> %s", (env, dir) => {
    expect(ompAgentDir(h, env)).toBe(dir);
  });
});

describe("a non-default bus home reaches every harness entry (#1443)", () => {
  const moved = (h: string) => join(h, "elsewhere");

  it("Claude: the CLI add and the file fallback both carry OA_BUS_HOME", async () => {
    const { h, deps, calls } = setup(["claude"]);
    deps.busHome = moved(h);
    await installAdapters(deps);
    const add = calls.find((c) => c.slice(0, 3).join(" ") === "claude mcp add");
    expect(add).toBeDefined();
    const at = (add as string[]).indexOf("-e");
    expect((add as string[])[at + 1]).toBe(`OA_BUS_HOME=${moved(h)}`);
    // Options end before the `--` that starts the server's argv.
    expect(at).toBeLessThan((add as string[]).indexOf("--"));

    deps.exec = fakeExec({ "claude mcp add": { code: 1, stderr: "no" } }).exec;
    put(p.claude(h), {});
    await installAdapters(deps);
    expect(readJ(p.claude(h)).mcpServers.oa_bus.env).toEqual({
      OA_BUS_HOME: moved(h),
    });
  });

  it("Claude: the default home adds no -e and an empty env", async () => {
    const { h, deps, calls } = setup(["claude"]);
    await installAdapters(deps);
    expect(calls).toContainEqual(CLAUDE_ADD);
    deps.busHome = join(h, ".oa-bus");
    deps.exec = fakeExec({ "claude mcp add": { code: 1, stderr: "no" } }).exec;
    put(p.claude(h), {});
    await installAdapters(deps);
    expect(readJ(p.claude(h)).mcpServers.oa_bus.env).toEqual({});
  });

  it("OpenCode: the MCP entry carries the home in environment, and a rerun rewrites it", async () => {
    const { h, deps } = setup(["opencode"]);
    deps.busHome = moved(h);
    await installAdapters(deps);
    expect(readJ(p.oc(h)).mcp.servers.oa_bus).toEqual({
      type: "local",
      command: [BIN, "mcp", "opencode"],
      environment: { OA_BUS_HOME: moved(h) },
    });
    // The TUI plugin runs inside OpenCode, so the home is set in its file.
    expect(
      readFileSync(
        join(moved(h), "integrations/opencode/oa_bus/tui.js"),
        "utf8",
      ),
    ).toContain(`process.env.OA_BUS_HOME ||= ${JSON.stringify(moved(h))};`);
    deps.busHome = undefined;
    await installAdapters(deps);
    expect(readJ(p.oc(h)).mcp.servers.oa_bus.environment).toBeUndefined();
  });

  it("Pi and oh-my-pi: the extension file sets the home, and omits it by default", async () => {
    const { h, deps } = setup(["pi", "omp"]);
    deps.busHome = moved(h);
    await installAdapters(deps);
    const line = `process.env.OA_BUS_HOME ||= ${JSON.stringify(moved(h))};`;
    expect(readFileSync(p.pi(h), "utf8")).toContain(line);
    expect(checkAdapters(deps).pi).toBe("configured");
    // The bus home moved back: the entry is stale until a reinstall.
    deps.busHome = undefined;
    expect(checkAdapters(deps).pi).toBe("missing");
    await installAdapters(deps);
    expect(readFileSync(p.pi(h), "utf8")).toBe("PI_ASSET");
    expect(checkAdapters(deps).pi).toBe("configured");
  });

  it("uninstall with the same non-default home removes the entries", async () => {
    const { h, deps } = setup(["claude", "opencode", "pi"]);
    deps.busHome = moved(h);
    await installAdapters(deps);
    const out = await uninstallAdapters(deps);
    expect(out.removed).toEqual(["claude", "opencode", "pi"]);
    expect(existsSync(p.pi(h))).toBe(false);
    expect(readJ(p.oc(h)).mcp?.servers?.oa_bus).toBeUndefined();
  });
});

describe("doctor and --check catch a missing or wrong home (#1443)", () => {
  it("an old Claude entry with env {} is missing under a moved home, and a rerun repairs it", async () => {
    const { h, deps } = setup(["claude"]);
    const fb = fakeExec({ "claude mcp add": { code: 1, stderr: "no" } });
    deps.exec = fb.exec;
    put(p.claude(h), {});
    await installAdapters(deps);
    expect(checkAdapters(deps).claude).toBe("configured");
    deps.busHome = join(h, "elsewhere");
    expect(checkAdapters(deps).claude).toBe("missing");
    await installAdapters(deps);
    expect(checkAdapters(deps).claude).toBe("configured");
    // And a stale home is wrong under the default again.
    deps.busHome = undefined;
    expect(checkAdapters(deps).claude).toBe("missing");
  });

  it("an old OpenCode entry and plugin are missing under a moved home, and a rerun repairs them", async () => {
    const { h, deps } = setup(["opencode"]);
    await installAdapters(deps);
    expect(checkAdapters(deps).opencode).toBe("configured");
    deps.busHome = join(h, "elsewhere");
    expect(checkAdapters(deps).opencode).toBe("missing");
    await installAdapters(deps);
    expect(checkAdapters(deps).opencode).toBe("configured");
    // Entry right, plugin file without the line: still missing.
    writeFileSync(
      join(h, "elsewhere/integrations/opencode/oa_bus/tui.js"),
      "PLUGIN_JS",
    );
    expect(checkAdapters(deps).opencode).toBe("missing");
  });
});
