// #1856: Pi's /mcp entry for the instance. Pi lets an mcp.json entry beat a
// server an extension registers under the same name, so install moves the
// entry out of mcp.json into a file the extension reads, and uninstall puts it
// back where it was.
import {
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
import { PI_ENTRY_FILE } from "../src/steps/pi-proof.ts";

const HUB = "https://oa.example.com";
const OAUTH = { type: "http", url: `${HUB}/mcp` };
const TOKEN = {
  type: "http",
  url: `${HUB}/mcp`,
  headers: { Authorization: "Bearer ${OA_TOKEN}" },
  exposure: "direct",
};
const OTHER = { type: "http", url: "https://elsewhere.test/mcp" };

const setup = (
  mcpJson: string | undefined,
  over: {
    version?: string;
    env?: Record<string, string>;
    hasPi?: boolean;
    dir?: string;
  } = {},
) => {
  const h = mkdtempSync(join(tmpdir(), "ob-pi1856-inst-"));
  const agent = over.dir ?? join(h, ".pi/agent");
  mkdirSync(agent, { recursive: true });
  const file = join(agent, "mcp.json");
  if (mcpJson !== undefined) writeFileSync(file, mcpJson);
  const calls: string[][] = [];
  const deps: AdapterDeps = {
    home: h,
    env: over.env ?? {},
    hub: HUB,
    busBin: ["/usr/local/bin/oa-bus"],
    assets: { pi: "PI", opencodePlugin: "JS" },
    which: (c) => c === "pi" && over.hasPi !== false,
    exec: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return cmd === "pi" && args[0] === "--version"
        ? { code: 0, stdout: `${over.version ?? "1.5.0"}\n`, stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    },
  };
  return {
    h,
    file,
    deps,
    calls,
    moved: join(h, ".oa-bus", PI_ENTRY_FILE),
    read: () => readFileSync(file, "utf8"),
  };
};
const doc = (servers: Record<string, unknown>, indent: number | string = 2) =>
  `${JSON.stringify({ autoEnableCodemode: true, mcpServers: servers }, null, indent)}\n`;
const names = (text: string) => Object.keys(JSON.parse(text).mcpServers);

describe("oa-bus install and uninstall, Pi mcp.json entry (#1856)", () => {
  for (const [kind, e] of [
    ["OAuth", OAUTH],
    ["token", TOKEN],
  ] as const)
    it(`${kind}: install moves the entry out, uninstall puts the bytes back`, async () => {
      const original = doc({ first: OTHER, "open-artifacts": e, last: OTHER });
      const s = setup(original);
      const r = await installAdapters(s.deps);
      expect(r.installed).toContain("pi");
      // Out of mcp.json (Pi lets that entry beat a registered server), the rest kept.
      expect(names(s.read())).toEqual(["first", "last"]);
      expect(JSON.parse(s.read()).autoEnableCodemode).toBe(true);
      // The extension reads it from a private file, byte for byte what it was.
      expect(JSON.parse(readFileSync(s.moved, "utf8"))).toMatchObject({
        name: "open-artifacts",
        config: e,
      });
      expect(statSync(s.moved).mode & 0o777).toBe(0o600);
      await uninstallAdapters(s.deps);
      expect(s.read()).toBe(original);
      expect(() => statSync(s.moved)).toThrow();
    });

  it("keeps the user's indentation, and the entry's place in the list", async () => {
    const original = doc({ a: OTHER, mine: OAUTH, z: OTHER }, "\t");
    const s = setup(original);
    await installAdapters(s.deps);
    expect(s.read()).toContain('\n\t\t"a"');
    await uninstallAdapters(s.deps);
    expect(s.read()).toBe(original);
  });

  it("a second install changes nothing", async () => {
    const s = setup(doc({ "open-artifacts": TOKEN }));
    await installAdapters(s.deps);
    const json = s.read();
    const moved = readFileSync(s.moved, "utf8");
    await installAdapters(s.deps);
    expect(s.read()).toBe(json);
    expect(readFileSync(s.moved, "utf8")).toBe(moved);
  });

  it("finds the entry by address, whatever the user named it", async () => {
    const s = setup(doc({ work: { ...OAUTH, url: `${HUB}/mcp/` }, x: OTHER }));
    await installAdapters(s.deps);
    expect(names(s.read())).toEqual(["x"]);
    expect(JSON.parse(readFileSync(s.moved, "utf8")).name).toBe("work");
  });

  it("leaves another instance's entry, a stdio entry and an entry on another path", async () => {
    const original = doc({
      other: OTHER,
      local: { command: "x", args: [] },
      page: { type: "http", url: `${HUB}/other` },
    });
    const s = setup(original);
    await installAdapters(s.deps);
    expect(s.read()).toBe(original);
    expect(() => statSync(s.moved)).toThrow();
  });

  it("no mcp.json: nothing is created", async () => {
    const s = setup(undefined);
    await installAdapters(s.deps);
    expect(() => readFileSync(s.file)).toThrow();
    expect(() => statSync(s.moved)).toThrow();
  });

  it("leaves a Pi older than 1.5.0, or one that will not say, with its entry and a note", async () => {
    for (const version of ["1.4.0", "0.9.9", "not a version"]) {
      const original = doc({ "open-artifacts": OAUTH });
      const s = setup(original, { version });
      const r = await installAdapters(s.deps);
      expect(s.read()).toBe(original);
      expect(() => statSync(s.moved)).toThrow();
      expect(r.notes.join("\n")).toContain(
        "Pi needs 1.5.0 or later to show as its own session on pages. Its tools still work.",
      );
    }
  });

  it("leaves an mcp.json it cannot parse as it is, and still installs", async () => {
    const s = setup("{ not json");
    const r = await installAdapters(s.deps);
    expect(s.read()).toBe("{ not json");
    expect(r.installed).toContain("pi");
    expect(r.notes.join("\n")).toMatch(/mcp\.json/);
  });

  it("does nothing without Pi", async () => {
    const original = doc({ "open-artifacts": OAUTH });
    const s = setup(original, { hasPi: false });
    await installAdapters(s.deps);
    expect(s.read()).toBe(original);
    expect(s.calls).toEqual([]);
  });

  it("follows PI_CODING_AGENT_DIR", async () => {
    const d = mkdtempSync(join(tmpdir(), "ob-pi1856-dir-"));
    const original = doc({ "open-artifacts": OAUTH });
    const s = setup(undefined, { dir: d, env: { PI_CODING_AGENT_DIR: d } });
    writeFileSync(join(d, "mcp.json"), original);
    await installAdapters(s.deps);
    expect(names(readFileSync(join(d, "mcp.json"), "utf8"))).toEqual([]);
    await uninstallAdapters(s.deps);
    expect(readFileSync(join(d, "mcp.json"), "utf8")).toBe(original);
  });

  it("uninstall leaves an entry the user put back since, and still removes the file", async () => {
    const s = setup(doc({ "open-artifacts": OAUTH }));
    await installAdapters(s.deps);
    const mine = { ...OAUTH, headers: { Authorization: "Bearer mine" } };
    writeFileSync(s.file, doc({ "open-artifacts": mine }));
    await uninstallAdapters(s.deps);
    expect(JSON.parse(s.read()).mcpServers["open-artifacts"]).toEqual(mine);
    expect(() => statSync(s.moved)).toThrow();
  });

  it("uninstalling twice puts it back once and changes nothing more", async () => {
    const original = doc({ "open-artifacts": OAUTH });
    const s = setup(original);
    await installAdapters(s.deps);
    await uninstallAdapters(s.deps);
    // A second uninstall has nothing to do and changes nothing.
    await uninstallAdapters(s.deps);
    expect(s.read()).toBe(original);
  });

  it("records the hub's origin with the entry, for the extension to check", async () => {
    const s = setup(doc({ "open-artifacts": OAUTH }));
    await installAdapters(s.deps);
    expect(JSON.parse(readFileSync(s.moved, "utf8")).origin).toBe(HUB);
  });

  it("an entry back in mcp.json wins: it replaces the moved one and leaves mcp.json again", async () => {
    const s = setup(doc({ "open-artifacts": OAUTH }));
    await installAdapters(s.deps);
    // The user re-adds it (or a crash left both): same address, new settings.
    writeFileSync(s.file, doc({ a: OTHER, mine: TOKEN }));
    await installAdapters(s.deps);
    expect(names(s.read())).toEqual(["a"]);
    const m = JSON.parse(readFileSync(s.moved, "utf8"));
    expect(m).toMatchObject({ name: "mine", index: 1, config: TOKEN });
    await uninstallAdapters(s.deps);
    expect(names(s.read())).toEqual(["a", "mine"]);
  });

  it("a crash between the two steps (both exist) is finished by the next install", async () => {
    const s = setup(doc({ "open-artifacts": OAUTH }));
    mkdirSync(join(s.h, ".oa-bus"), { recursive: true });
    writeFileSync(
      s.moved,
      JSON.stringify({ name: "open-artifacts", index: 0, config: OAUTH }),
    );
    await installAdapters(s.deps);
    expect(names(s.read())).toEqual([]);
    expect(JSON.parse(readFileSync(s.moved, "utf8")).origin).toBe(HUB);
  });

  it("with oh-my-pi in the same folder, it leaves the entry and says so", async () => {
    const d = mkdtempSync(join(tmpdir(), "ob-pi1856-shared-"));
    const original = doc({ "open-artifacts": OAUTH });
    const s = setup(undefined, { dir: d, env: { PI_CODING_AGENT_DIR: d } });
    writeFileSync(join(d, "mcp.json"), original);
    const deps = { ...s.deps, which: (c: string) => c === "pi" || c === "omp" };
    const r = await installAdapters(deps);
    expect(readFileSync(join(d, "mcp.json"), "utf8")).toBe(original);
    expect(() => statSync(s.moved)).toThrow();
    expect(r.notes.join("\n")).toContain(
      "oh-my-pi reads the same file, and moving the entry would take its tools away. Pi won't show as its own session on pages.",
    );
  });

  it("uninstall that cannot put the entry back keeps the extension (also for oh-my-pi) and the moved file", async () => {
    const d = mkdtempSync(join(tmpdir(), "ob-pi1856-keep-"));
    const s = setup(undefined, { dir: d, env: { PI_CODING_AGENT_DIR: d } });
    writeFileSync(join(d, "mcp.json"), doc({ "open-artifacts": OAUTH }));
    // Only Pi at install; oh-my-pi is there at uninstall.
    await installAdapters(s.deps);
    writeFileSync(join(d, "mcp.json"), "{ broken");
    const deps = { ...s.deps, which: (c: string) => c === "pi" || c === "omp" };
    const r = await uninstallAdapters(deps);
    expect(r.skipped.map((k) => k.harness)).toEqual(["pi"]);
    expect(r.removed).not.toContain("omp");
    expect(statSync(join(d, "extensions/oa-bus.ts")).isFile()).toBe(true);
    expect(statSync(s.moved).isFile()).toBe(true);
    expect(r.notes.join("\n")).toContain(join(d, "mcp.json"));
  });

  it("the extension reads the file install writes", () => {
    const asset = readFileSync(
      join(__dirname, "../../bus-adapter-pi/assets/oa-bus.ts"),
      "utf8",
    );
    expect(asset).toContain(`"${PI_ENTRY_FILE}"`);
  });
});
