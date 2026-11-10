// #1856: Codex's own remote entry cannot add a per-thread proof, so install
// swaps the instance's bearer-env entry, in place and under its name, for the
// local proxy (`oa-bus mcp-proxy --for codex`), keeps the user's table in the
// bus home (0600), and uninstall puts it back. Only Codex 0.123 or later,
// which sends the thread id with each call.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_PROXY_ENTRY_FILE } from "@oa/bus-daemon";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  type AdapterDeps,
  installAdapters,
  uninstallAdapters,
} from "../src/steps/adapters.ts";

const HUB = "https://oa.example.com";
const BIN = ["/usr/local/bin/oa-bus"];

const REMOTE = [
  "[mcp_servers.open-artifacts]",
  `url = "${HUB}/mcp"`,
  'bearer_token_env_var = "OA_TOKEN"',
  "tool_timeout_sec = 90",
  "",
  "[mcp_servers.open-artifacts.tools.list_artifacts]",
  'approval_mode = "approve"',
].join("\n");
const PREFIX = [
  "# my codex",
  'model = "gpt-5"',
  "",
  "[mcp_servers.github]",
  'command = "npx"',
  'args = ["-y", "gh-mcp"]',
  "",
].join("\n");
const SUFFIX = ["", "[desktop]", 'followUpQueueMode = "queue"', ""].join("\n");
const ORIGINAL = `${PREFIX}${REMOTE}\n${SUFFIX}`;

type Exec = AdapterDeps["exec"];

function setup(
  config: string | undefined,
  over: { hub?: string | null; version?: string | null; busHome?: string } = {},
) {
  const h = mkdtempSync(join(tmpdir(), "ob-cx1856-"));
  const codexHome = join(h, "codex-home");
  mkdirSync(codexHome);
  const file = join(codexHome, "config.toml");
  if (config !== undefined) writeFileSync(file, config);
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "codex" && args[0] === "--version")
      return over.version === null
        ? { code: 1, stdout: "", stderr: "nope" }
        : {
            code: 0,
            stdout: `codex-cli ${over.version ?? "0.167.0"}\n`,
            stderr: "",
          };
    return { code: 0, stdout: "", stderr: "" };
  };
  const deps: AdapterDeps = {
    home: h,
    env: { CODEX_HOME: codexHome, PATH: "" },
    ...(over.hub === null ? {} : { hub: over.hub ?? HUB }),
    ...(over.busHome ? { busHome: over.busHome } : {}),
    busBin: BIN,
    assets: { pi: "P", opencodePlugin: "J" },
    which: (c) => c === "codex",
    exec,
  };
  return {
    h,
    file,
    deps,
    calls,
    moved: join(over.busHome ?? join(h, ".oa-bus"), CODEX_PROXY_ENTRY_FILE),
    read: () => readFileSync(file, "utf8"),
    toml: () =>
      parse(readFileSync(file, "utf8")) as {
        mcp_servers: Record<string, Record<string, unknown>>;
      },
  };
}

const PROXY_ARGS = [
  "mcp-proxy",
  "--instance",
  HUB,
  "--for",
  "codex",
  "--token-env",
  "OA_TOKEN",
];

describe("oa-bus install and uninstall, Codex /mcp entry (#1856)", () => {
  it("swaps the bearer-env entry for the proxy in place, keeping its other keys and tables", async () => {
    const t = setup(ORIGINAL);
    await installAdapters(t.deps);
    const e = t.toml().mcp_servers["open-artifacts"];
    expect(e).toMatchObject({
      command: BIN[0],
      args: PROXY_ARGS,
      env_vars: ["OA_TOKEN"],
      tool_timeout_sec: 90,
      tools: { list_artifacts: { approval_mode: "approve" } },
    });
    expect(e).not.toHaveProperty("url");
    expect(e).not.toHaveProperty("bearer_token_env_var");
    // The table keeps its place and everything around it is byte for byte.
    const text = t.read();
    expect(text.startsWith(PREFIX)).toBe(true);
    expect(text).toContain(SUFFIX);
    expect(Object.keys(t.toml().mcp_servers)).toEqual([
      "github",
      "open-artifacts",
      "oa_bus",
    ]);
    // The token is a name, never a value; the moved file is private.
    expect(statSync(t.moved).mode & 0o777).toBe(0o600);
    const moved = readFileSync(t.moved, "utf8");
    expect(JSON.parse(moved)).toMatchObject({ name: "open-artifacts" });
    expect(moved).toContain("OA_TOKEN");
  });

  it("uninstall puts the user's table back, byte for byte, and removes our files", async () => {
    const t = setup(ORIGINAL);
    await installAdapters(t.deps);
    await uninstallAdapters(t.deps);
    expect(t.read()).toBe(ORIGINAL);
    expect(existsSync(t.moved)).toBe(false);
  });

  it("is idempotent and brings an earlier proxy entry up to date", async () => {
    const t = setup(ORIGINAL);
    await installAdapters(t.deps);
    const once = t.read();
    await installAdapters(t.deps);
    expect(t.read()).toBe(once);
    t.deps.busBin = ["/other/oa-bus"];
    await installAdapters(t.deps);
    expect(t.toml().mcp_servers["open-artifacts"]?.command).toBe(
      "/other/oa-bus",
    );
    // Still one round trip back to the user's own table.
    await uninstallAdapters(t.deps);
    expect(t.read()).toBe(ORIGINAL);
  });

  it("passes a moved bus home in the entry's env", async () => {
    const t = setup(ORIGINAL);
    const busHome = join(t.h, "elsewhere");
    mkdirSync(busHome);
    t.deps.busHome = busHome;
    await installAdapters(t.deps);
    expect(t.toml().mcp_servers["open-artifacts"]?.env).toEqual({
      OA_BUS_HOME: busHome,
    });
    expect(existsSync(join(busHome, CODEX_PROXY_ENTRY_FILE))).toBe(true);
    await uninstallAdapters(t.deps);
    expect(t.read()).toBe(ORIGINAL);
  });

  it("keeps an edit the user made to the proxy table since, and still restores the remote keys", async () => {
    const t = setup(ORIGINAL);
    await installAdapters(t.deps);
    writeFileSync(
      t.file,
      t.read().replace("tool_timeout_sec = 90", "tool_timeout_sec = 120"),
    );
    await uninstallAdapters(t.deps);
    const e = t.toml().mcp_servers["open-artifacts"];
    expect(e).toMatchObject({
      url: `${HUB}/mcp`,
      bearer_token_env_var: "OA_TOKEN",
      tool_timeout_sec: 120,
    });
    expect(e).not.toHaveProperty("command");
    expect(existsSync(t.moved)).toBe(false);
  });

  it("leaves a table the user turned into something else alone on uninstall", async () => {
    const t = setup(ORIGINAL);
    await installAdapters(t.deps);
    writeFileSync(
      t.file,
      t.read().replace('"--for", "codex"', '"--for", "vim"'),
    );
    await uninstallAdapters(t.deps);
    const e = t.toml().mcp_servers["open-artifacts"];
    expect(e?.args).toContain("vim");
    expect(e).not.toHaveProperty("url");
  });

  const KEEP: [string, string][] = [
    ["OAuth (no token variable)", `url = "${HUB}/mcp"`],
    ["a literal bearer token", `url = "${HUB}/mcp"\nbearer_token = "x"`],
    [
      "static headers",
      `url = "${HUB}/mcp"\nbearer_token_env_var = "OA_TOKEN"\nhttp_headers = { A = "b" }`,
    ],
    [
      "env headers",
      `url = "${HUB}/mcp"\nenv_http_headers = { Authorization = "OA_AUTH" }`,
    ],
    ["a header helper", `url = "${HUB}/mcp"\nhttp_headers_helper = "get-it"`],
    [
      "an oauth block",
      `url = "${HUB}/mcp"\nbearer_token_env_var = "OA_TOKEN"\noauth_resource = "r"`,
    ],
    [
      "another instance",
      `url = "https://elsewhere.test/mcp"\nbearer_token_env_var = "OA_TOKEN"`,
    ],
    [
      "a different path",
      `url = "${HUB}/other"\nbearer_token_env_var = "OA_TOKEN"`,
    ],
    [
      "a disabled entry",
      `url = "${HUB}/mcp"\nbearer_token_env_var = "OA_TOKEN"\nenabled = false`,
    ],
  ];
  for (const [kind, body] of KEEP)
    it(`${kind}: the entry stays as it is and uninstall changes nothing`, async () => {
      const original = `${PREFIX}[mcp_servers.open-artifacts]\n${body}\n${SUFFIX}`;
      const t = setup(original);
      const out = await installAdapters(t.deps);
      expect(t.toml().mcp_servers["open-artifacts"]).toEqual(
        (parse(original) as { mcp_servers: Record<string, unknown> })
          .mcp_servers["open-artifacts"],
      );
      expect(existsSync(t.moved)).toBe(false);
      await uninstallAdapters(t.deps);
      expect(t.toml().mcp_servers["open-artifacts"]).toBeDefined();
      if (
        kind.startsWith("OAuth") ||
        kind.startsWith("a literal") ||
        kind.startsWith("static") ||
        kind.startsWith("env") ||
        kind.startsWith("a header") ||
        kind.startsWith("an oauth")
      )
        expect(out.notes.join("\n")).toMatch(/left the open-artifacts entry/);
    });

  it("leaves an entry written as an inline table alone, with a note", async () => {
    const original = `${PREFIX}[mcp_servers]\nopen-artifacts = { url = "${HUB}/mcp", bearer_token_env_var = "OA_TOKEN" }\n`;
    const t = setup(original);
    const out = await installAdapters(t.deps);
    expect(t.toml().mcp_servers["open-artifacts"]).toHaveProperty("url");
    expect(existsSync(t.moved)).toBe(false);
    expect(out.notes.join("\n")).toMatch(
      /left the open-artifacts entry .* as it is/,
    );
  });

  it("refuses an http address that is not localhost, and no hub means nothing is swapped", async () => {
    const http = ORIGINAL.replaceAll(HUB, "http://oa.example.com");
    const a = setup(http, { hub: "http://oa.example.com" });
    const out = await installAdapters(a.deps);
    expect(a.read()).toContain("[mcp_servers.oa_bus]");
    expect(a.toml().mcp_servers["open-artifacts"]).toHaveProperty("url");
    expect(out.notes.join("\n")).toMatch(/https/);
    const b = setup(ORIGINAL, { hub: null });
    await installAdapters(b.deps);
    expect(b.toml().mcp_servers["open-artifacts"]).toHaveProperty("url");
  });

  it("swaps an entry for a localhost dev instance over http", async () => {
    const dev = "http://127.0.0.1:8787";
    const t = setup(ORIGINAL.replaceAll(HUB, dev), { hub: dev });
    await installAdapters(t.deps);
    expect(t.toml().mcp_servers["open-artifacts"]?.args).toContain(dev);
  });

  describe("the Codex version gate (0.123 or later)", () => {
    it("swaps from 0.123.0 on", async () => {
      for (const v of ["0.123.0", "0.167.0", "1.0.0", "0.200.1-alpha.1"]) {
        const t = setup(ORIGINAL, { version: v });
        await installAdapters(t.deps);
        expect(t.toml().mcp_servers["open-artifacts"]).toHaveProperty(
          "command",
        );
      }
    });

    it("leaves the entry as it is, with a note, below 0.123 or when the version is unknown", async () => {
      for (const version of ["0.47.0", "0.122.9", null]) {
        const t = setup(ORIGINAL, { version });
        const out = await installAdapters(t.deps);
        expect(t.toml().mcp_servers["open-artifacts"]).toHaveProperty("url");
        expect(existsSync(t.moved)).toBe(false);
        expect(out.notes.join("\n")).toMatch(
          /Codex needs 0\.123 or later|could not tell which Codex/,
        );
      }
    });

    it("asks `codex --version` only when there is an entry to swap", async () => {
      const t = setup(`${PREFIX}`);
      await installAdapters(t.deps);
      expect(t.calls.filter((c) => c[1] === "--version")).toEqual([]);
    });
  });

  it("never reads a token: the proxy's token variable is a name in args and env_vars", async () => {
    const t = setup(ORIGINAL);
    await installAdapters(t.deps);
    expect(t.read()).not.toMatch(/Bearer/);
    expect(t.read()).toContain('env_vars = ["OA_TOKEN"]');
  });
});
