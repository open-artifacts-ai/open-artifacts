// #1856: OpenCode's /mcp entry for the instance. OpenCode's own remote entry
// cannot carry a per-session proof, so install replaces a token-file entry,
// in its own place under its own name, with the local proxy, and uninstall
// puts the user's entry back.
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
import { describe, expect, it } from "vitest";
import {
  type AdapterDeps,
  installAdapters,
  uninstallAdapters,
} from "../src/steps/adapters.ts";
import { OPENCODE_ENTRY_FILE } from "../src/steps/opencode-proof.ts";

const HUB = "https://oa.example.com";
const BIN = "/usr/local/bin/oa-bus";
const TOKEN_FILE = "~/.open-artifacts/oa-example-com-pat-token";
const TOKEN = {
  type: "remote",
  url: `${HUB}/mcp`,
  oauth: false,
  headers: { Authorization: `Bearer {file:${TOKEN_FILE}}` },
};
const OAUTH = { type: "remote", url: `${HUB}/mcp` };
const ENV = {
  type: "remote",
  url: `${HUB}/mcp`,
  oauth: false,
  headers: { Authorization: "Bearer {env:OA_TOKEN}" },
};
const OTHER = { type: "remote", url: "https://elsewhere.test/mcp" };
const PROXY = (file = TOKEN_FILE, bin = [BIN]) => ({
  type: "local",
  command: [...bin, "mcp-proxy", "--instance", HUB, "--token-file", file],
});

function setup(config: string | undefined, over: { hub?: string | null } = {}) {
  const h = mkdtempSync(join(tmpdir(), "ob-oc1856-"));
  const dir = join(h, ".config/opencode");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "opencode.json");
  if (config !== undefined) writeFileSync(file, config);
  const deps: AdapterDeps = {
    home: h,
    env: {},
    ...(over.hub === null ? {} : { hub: over.hub ?? HUB }),
    busBin: [BIN],
    assets: { pi: "PI", opencodePlugin: "JS" },
    which: (c) => c === "opencode",
    exec: async (cmd, args) =>
      cmd === "opencode" && args[0] === "--version"
        ? { code: 0, stdout: "opencode v2.2.5\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
  };
  return {
    h,
    file,
    deps,
    moved: join(h, ".oa-bus", OPENCODE_ENTRY_FILE),
    read: () => readFileSync(file, "utf8"),
    json: () => JSON.parse(readFileSync(file, "utf8")),
  };
}
const doc = (servers: Record<string, unknown>) =>
  `${JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { servers } }, null, 2)}\n`;
const keys = (o: Record<string, unknown>) => Object.keys(o);

describe("oa-bus install and uninstall, OpenCode /mcp entry (#1856)", () => {
  it("a token-file entry becomes the proxy, in place; uninstall puts the entry back", async () => {
    const original = doc({
      first: OTHER,
      "open-artifacts": TOKEN,
      last: OTHER,
    });
    const t = setup(original);
    await installAdapters(t.deps);
    const servers = t.json().mcp.servers;
    expect(keys(servers)).toEqual([
      "first",
      "open-artifacts",
      "last",
      "oa_bus",
    ]);
    expect(servers["open-artifacts"]).toEqual(PROXY());
    expect(servers.first).toEqual(OTHER);
    expect(statSync(t.moved).mode & 0o777).toBe(0o600);
    // The token's path is kept, its value is never read.
    expect(readFileSync(t.moved, "utf8")).not.toMatch(/Bearer [^{]/);
    await uninstallAdapters(t.deps);
    // The same entry, in the same place (the restored entry may sit on one line).
    expect(t.json()).toEqual(JSON.parse(original));
    expect(keys(t.json().mcp.servers)).toEqual([
      "first",
      "open-artifacts",
      "last",
    ]);
    expect(existsSync(t.moved)).toBe(false);
  });

  it("keeps comments and the layout of a .jsonc file through the round trip", async () => {
    const original = `{\n  // my servers\n  "mcp": {\n    "servers": {\n      /* the instance */\n      "open-artifacts": ${JSON.stringify(TOKEN)}\n    }\n  }\n}\n`;
    const t = setup(undefined);
    const jsonc = join(t.h, ".config/opencode/opencode.jsonc");
    writeFileSync(jsonc, original);
    await installAdapters(t.deps);
    const mid = readFileSync(jsonc, "utf8");
    expect(mid).toContain("// my servers");
    expect(mid).toContain("/* the instance */");
    await uninstallAdapters(t.deps);
    expect(readFileSync(jsonc, "utf8")).toBe(original);
  });

  it("finds an entry written straight under mcp as well", async () => {
    const original = `${JSON.stringify({ mcp: { "open-artifacts": TOKEN } }, null, 2)}\n`;
    const t = setup(original);
    await installAdapters(t.deps);
    expect(t.json().mcp["open-artifacts"]).toEqual(PROXY());
    await uninstallAdapters(t.deps);
    expect(t.json().mcp["open-artifacts"]).toEqual(TOKEN);
  });

  it("works for an entry under any name the user chose", async () => {
    const t = setup(doc({ work: TOKEN }));
    await installAdapters(t.deps);
    expect(t.json().mcp.servers.work).toEqual(PROXY());
  });

  for (const [kind, e] of [
    ["OAuth", OAUTH],
    ["an env token", ENV],
  ] as const)
    it(`${kind}: the entry stays as it is, with a note, and uninstall changes nothing`, async () => {
      const original = doc({ "open-artifacts": e });
      const t = setup(original);
      const out = await installAdapters(t.deps);
      expect(t.json().mcp.servers["open-artifacts"]).toEqual(e);
      expect(out.notes.join("\n")).toMatch(/open-artifacts/);
      expect(out.notes.join("\n")).toMatch(/tools still work/);
      expect(existsSync(t.moved)).toBe(false);
      await uninstallAdapters(t.deps);
      expect(t.json().mcp.servers["open-artifacts"]).toEqual(e);
    });

  it("leaves another instance's entry, a disabled entry, and a run with no instance alone", async () => {
    const t = setup(doc({ other: OTHER, off: { ...TOKEN, enabled: false } }));
    await installAdapters(t.deps);
    expect(t.json().mcp.servers.other).toEqual(OTHER);
    expect(t.json().mcp.servers.off).toEqual({ ...TOKEN, enabled: false });
    const n = setup(doc({ "open-artifacts": TOKEN }), { hub: null });
    await installAdapters(n.deps);
    expect(n.json().mcp.servers["open-artifacts"]).toEqual(TOKEN);
  });

  it("install twice changes nothing more, and a moved binary refreshes the command", async () => {
    const t = setup(doc({ "open-artifacts": TOKEN }));
    await installAdapters(t.deps);
    const once = t.read();
    const movedOnce = readFileSync(t.moved, "utf8");
    await installAdapters(t.deps);
    expect(t.read()).toBe(once);
    expect(readFileSync(t.moved, "utf8")).toBe(movedOnce);
    t.deps.busBin = ["/opt/node", "/h/oa-bus.js"];
    await installAdapters(t.deps);
    expect(t.json().mcp.servers["open-artifacts"]).toEqual(
      PROXY(TOKEN_FILE, ["/opt/node", "/h/oa-bus.js"]),
    );
    await uninstallAdapters(t.deps);
    expect(t.json().mcp.servers["open-artifacts"]).toEqual(TOKEN);
  });

  it("an entry the user changed since is theirs: uninstall keeps it and drops the moved file", async () => {
    const t = setup(doc({ "open-artifacts": TOKEN }));
    await installAdapters(t.deps);
    const mine = { type: "remote", url: "https://mine.test/mcp" };
    const cfg = t.json();
    cfg.mcp.servers["open-artifacts"] = mine;
    writeFileSync(t.file, JSON.stringify(cfg));
    await uninstallAdapters(t.deps);
    expect(t.json().mcp.servers["open-artifacts"]).toEqual(mine);
    expect(existsSync(t.moved)).toBe(false);
  });

  it("a config that cannot be read never stops the install", async () => {
    const t = setup("{ not json");
    const out = await installAdapters(t.deps).catch((e) => e);
    expect(out).not.toBeInstanceOf(Error);
    expect(existsSync(t.moved)).toBe(false);
  });
});
