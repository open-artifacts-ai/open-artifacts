import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p));
const json = (p: string) => JSON.parse(read(p).toString("utf8"));

const PLUGIN = "plugins/open-artifacts";
const STYLE_SRC = "packages/bus-cli/output-style/artifacts-teammate.md";
const STYLE_COPY = `${PLUGIN}/output-styles/artifacts-teammate.md`;

describe("Claude Code plugin (#1970)", () => {
  it("ships a byte-identical copy of the output style", () => {
    expect(read(STYLE_COPY).equals(read(STYLE_SRC))).toBe(true);
  });

  it("never forces the style on", () => {
    expect(read(STYLE_COPY).toString("utf8")).not.toMatch(/force-for-plugin/);
    const manifest = json(`${PLUGIN}/.claude-plugin/plugin.json`);
    expect(manifest.settings).toBeUndefined();
  });

  it("has a valid manifest that carries only the style", () => {
    const m = json(`${PLUGIN}/.claude-plugin/plugin.json`);
    expect(m.name).toBe("open-artifacts");
    expect(m.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(m.author.name).toBeTruthy();
    expect(m.description).toMatch(/later version/);
    for (const k of [
      "mcpServers",
      "skills",
      "hooks",
      "userConfig",
      "commands",
      "agents",
    ]) {
      expect(m[k], k).toBeUndefined();
    }
  });

  it("has a marketplace entry that points at the plugin", () => {
    const mk = json(".claude-plugin/marketplace.json");
    expect(mk.name).toBe("open-artifacts");
    expect(mk.owner.name).toBeTruthy();
    expect(mk.plugins).toHaveLength(1);
    const [e] = mk.plugins;
    expect(e.name).toBe(json(`${PLUGIN}/.claude-plugin/plugin.json`).name);
    expect(e.source).toBe(`./${PLUGIN}`);
    expect(e.source).not.toContain("..");
  });

  it("has no version, so release-please never rewrites the manifest", () => {
    expect(
      json(`${PLUGIN}/.claude-plugin/plugin.json`).version,
    ).toBeUndefined();
    const cfg = json("release-please-config.json").packages["."];
    expect(cfg["extra-files"]).toBeUndefined();
  });
});
