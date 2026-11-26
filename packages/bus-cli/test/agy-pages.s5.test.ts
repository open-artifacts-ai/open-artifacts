// agy S5: `oa-bus install` (behind OA_BUS_EXPERIMENTAL_AGY=1) points
// Antigravity's Open Artifacts entry at the local proxy, which adds each
// conversation's link proof; added instances get the `--name` form; doctor
// reports each entry; uninstall puts the user's entry back byte for byte.
// A fake agy on PATH (deps.which) and a scratch HOME only: no real agy runs.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonSocketPath } from "@oa/bus-adapter-claude-code";
import { jsoncValue } from "@oa/bus-adapter-mcp-json";
import { saveInstance } from "@oa/bus-daemon";
import { describe, expect, it } from "vitest";
import { parse } from "../src/index.ts";
import {
  type AdapterDeps,
  agyEntryIo,
  agyTargets,
  installAdapters,
  uninstallAdapters,
} from "../src/steps/adapters.ts";
import { AGY_TOKEN_ENV, agyPagesState } from "../src/steps/agy-proof.ts";
import { TOKEN } from "./fake.ts";

const HUB = "https://artifacts.example.com";
const MIT = "https://mit-ai.example.com";
const PAT = `oa_pat_${"b".repeat(40)}`;
const BIN = ["/opt/node/bin/node", "/h/.oa-bus/bin/oa-bus.js"];
const ON = { OA_BUS_EXPERIMENTAL_AGY: "1" };

function setup(opts: { env?: Record<string, string>; busHome?: string } = {}) {
  const h = mkdtempSync(join(tmpdir(), "ob-agy5-"));
  const deps: AdapterDeps = {
    home: h,
    env: opts.env ?? ON,
    busBin: BIN,
    hub: HUB,
    ...(opts.busHome ? { busHome: opts.busHome } : {}),
    assets: { pi: "PI_ASSET", opencodePlugin: "PLUGIN_JS" },
    which: (cmd) => cmd === "agy" || cmd === "node",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  return {
    h,
    deps,
    file: join(h, ".gemini/config/mcp_config.json"),
    moved: join(opts.busHome ?? join(h, ".oa-bus"), "agy-pages-entries.json"),
  };
}

const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const read = (path: string) => readFileSync(path, "utf8");
const entry = (text: string, name = "open-artifacts") =>
  jsoncValue(text.replace(/^﻿/, ""), ["mcpServers", name]) as Record<
    string,
    unknown
  >;

// What `agy mcp add --header "Authorization: Bearer …" open-artifacts <url>`
// writes (agy 1.5.17), plus a comment and another server of the user's.
const THEIRS = (
  url = `${HUB}/mcp`,
  headers = `"Authorization": "Bearer ${PAT}"`,
) => `{
  // mine
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "server-fs", "/work"] },
    "open-artifacts": {
      "disabled": false,
      "headers": {
        ${headers}
      },
      "serverUrl": "${url}"
    }
  }
}
`;

const PROXY_ARGS = [
  BIN[1],
  "mcp-proxy",
  "--instance",
  HUB,
  "--for",
  "antigravity",
  "--token-env",
  AGY_TOKEN_ENV,
];

describe("Antigravity pages entry (agy S5)", () => {
  it("is left alone without OA_BUS_EXPERIMENTAL_AGY=1", async () => {
    const { deps, file } = setup({ env: {} });
    put(file, THEIRS());
    await installAdapters(deps);
    expect(read(file)).toBe(THEIRS());
  });

  it("swaps the instance's entry for the proxy, the token in env only, and uninstall puts the file back byte for byte", async () => {
    const { deps, file, moved } = setup();
    put(file, THEIRS());
    const r = await installAdapters(deps);
    expect(r.installed).toContain("antigravity");
    const text = read(file);
    const e = entry(text);
    expect(e).toEqual({
      disabled: false,
      command: BIN[0],
      args: PROXY_ARGS,
      env: { [AGY_TOKEN_ENV]: PAT },
    });
    // The rest of the file is the user's, comment included.
    expect(text).toContain("// mine");
    expect(entry(text, "fs")).toEqual({
      command: "npx",
      args: ["-y", "server-fs", "/work"],
    });
    // The token is never an argument, nor copied to the bus home.
    expect(JSON.stringify(e.args)).not.toContain(PAT);
    expect(read(moved)).not.toContain(PAT);
    expect(statSync(moved).mode & 0o777).toBe(0o600);
    // A second install changes nothing.
    await installAdapters(deps);
    expect(read(file)).toBe(text);
    await uninstallAdapters(deps);
    // oa_bus is gone and the user's entry is back exactly.
    expect(read(file)).toBe(THEIRS());
  });

  it("an entry with no header uses the PAT file when there is one, else stays with a note", async () => {
    const a = setup();
    put(a.file, THEIRS(`${HUB}/mcp`, ""));
    const r = await installAdapters(a.deps);
    expect(entry(read(a.file)).serverUrl).toBe(`${HUB}/mcp`);
    expect(r.notes.join("\n")).toMatch(
      /no PAT at .*artifacts-example-com-pat-token/,
    );
    const b = setup();
    put(b.file, THEIRS(`${HUB}/mcp`, ""));
    const pat = join(b.h, ".open-artifacts", "artifacts-example-com-pat-token");
    put(pat, PAT);
    await installAdapters(b.deps);
    const e = entry(read(b.file));
    expect(e.args).toEqual([...PROXY_ARGS.slice(0, -2), "--token-file", pat]);
    expect(e).not.toHaveProperty("env");
    await uninstallAdapters(b.deps);
    expect(read(b.file)).toBe(THEIRS(`${HUB}/mcp`, ""));
  });

  it("leaves an entry with other headers, another address, or turned off", async () => {
    for (const text of [
      THEIRS(`${HUB}/mcp`, `"Authorization": "Bearer ${PAT}", "X-Other": "1"`),
      THEIRS("https://elsewhere.example.com/mcp"),
      THEIRS().replace('"disabled": false', '"disabled": true'),
    ]) {
      const { deps, file } = setup();
      put(file, text);
      await installAdapters(deps);
      expect(entry(read(file))).toEqual(entry(text));
    }
  });

  it("gives an added instance's entry the --name form", async () => {
    const bus = mkdtempSync(join(tmpdir(), "ob-agy5-bus-"));
    saveInstance(
      {
        name: "mit-ai",
        hub: MIT,
        machine_id: "",
        label: "m",
        machine_token: TOKEN,
      },
      bus,
    );
    const { deps, file } = setup({ busHome: bus });
    put(
      file,
      THEIRS().replace(
        '"fs":',
        `"oa-mit": { "serverUrl": "${MIT}/mcp", "headers": { "Authorization": "Bearer ${PAT}" } },\n    "fs":`,
      ),
    );
    expect(agyTargets(deps)).toEqual([
      { origin: HUB },
      { origin: MIT, name: "mit-ai" },
    ]);
    await installAdapters(deps);
    const e = entry(read(file), "oa-mit");
    expect(e.args).toEqual([
      BIN[1],
      "mcp-proxy",
      "--instance",
      MIT,
      "--for",
      "antigravity",
      "--name",
      "mit-ai",
      "--token-env",
      AGY_TOKEN_ENV,
    ]);
    expect(e.env).toEqual({ [AGY_TOKEN_ENV]: PAT, OA_BUS_HOME: bus });
  });

  it("leaves another running bus's proxy entry, and takes one whose bus has stopped (#3075)", async () => {
    const other = mkdtempSync(join(tmpdir(), "ob-agy5-other-"));
    const theirs = (home: string) =>
      `{\n  "mcpServers": {\n    "open-artifacts": ${JSON.stringify({
        command: BIN[0],
        args: PROXY_ARGS,
        env: { [AGY_TOKEN_ENV]: PAT, OA_BUS_HOME: home },
      })}\n  }\n}\n`;
    // A running bus holds its daemon socket.
    put(daemonSocketPath(other), "");
    const a = setup();
    put(a.file, theirs(other));
    const r = await installAdapters(a.deps);
    expect(entry(read(a.file)).env).toMatchObject({ OA_BUS_HOME: other });
    expect(r.notes.join("\n")).toContain(`belongs to the bus at ${other}`);
    const gone = join(other, "gone");
    const b = setup();
    put(b.file, theirs(gone));
    await installAdapters(b.deps);
    expect(entry(read(b.file))).toEqual({
      command: BIN[0],
      args: PROXY_ARGS,
      env: { [AGY_TOKEN_ENV]: PAT },
    });
    // Uninstall gives the user an http entry with their token.
    await uninstallAdapters(b.deps);
    expect(entry(read(b.file))).toEqual({
      disabled: false,
      headers: { Authorization: `Bearer ${PAT}` },
      serverUrl: `${HUB}/mcp`,
    });
  });

  it("doctor's state: pending, linked, then missing program", async () => {
    const { deps, file } = setup();
    put(file, THEIRS());
    const state = (which = deps.which) =>
      agyPagesState(agyEntryIo(deps), agyTargets(deps), which);
    expect(state()).toEqual([
      { state: "pending", name: "open-artifacts", origin: HUB },
    ]);
    await installAdapters(deps);
    expect(state()).toEqual([
      { state: "missing", name: "open-artifacts", program: BIN[0] },
    ]);
    const bin = join(deps.home, "oa-bus.js");
    put(bin, "");
    const d2 = { ...deps, busBin: ["node", bin] };
    await installAdapters(d2);
    expect(agyPagesState(agyEntryIo(d2), agyTargets(d2), d2.which)).toEqual([
      { state: "linked", name: "open-artifacts", origin: HUB },
    ]);
  });

  it("parses mcp-proxy --for antigravity with --name and --token-env", () => {
    expect(
      parse([
        "mcp-proxy",
        "--instance",
        MIT,
        "--for",
        "antigravity",
        "--name",
        "mit-ai",
        "--token-env",
        AGY_TOKEN_ENV,
      ]),
    ).toMatchObject({
      cmd: "mcp-proxy",
      hub: MIT,
      for: "antigravity",
      name: "mit-ai",
      tokenEnv: AGY_TOKEN_ENV,
    });
    expect(() =>
      parse(["mcp-proxy", "--instance", MIT, "--name", "mit-ai"]),
    ).toThrow(/--name needs --for antigravity/);
  });
});
