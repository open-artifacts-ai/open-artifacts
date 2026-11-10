// The "Artifacts Teammate" Claude Code output style the installer writes (#1970).
// Temp homes only. The style is never made active and settings.json is never touched.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installOutputStyle,
  OUTPUT_STYLE_MARKER,
  outputStyleFile,
  outputStyleSource,
  outputStyleState,
  uninstallOutputStyle,
} from "../src/steps/output-style.ts";

const home = () => mkdtempSync(join(tmpdir(), "oa-style-home-"));
const SOURCE = readFileSync(
  join(import.meta.dirname, "../output-style/artifacts-teammate.md"),
  "utf8",
);
const text = SOURCE;
const file = (h: string, env = {}) => outputStyleFile({ home: h, env });

describe("the shipped text", () => {
  it("is the source file unchanged", () => {
    expect(outputStyleSource()).toBe(SOURCE);
  });

  it("has frontmatter with name, description and keep-coding-instructions", () => {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(SOURCE);
    const keys = (m?.[1] ?? "").split("\n").map((l) => l.split(":", 1)[0]);
    expect(keys).toEqual(["name", "description", "keep-coding-instructions"]);
  });
});

describe("installOutputStyle", () => {
  it("writes the file with our marker right after the frontmatter, once", () => {
    const h = home();
    const r = installOutputStyle({ home: h, text }, ["claude"]);
    expect(r.written).toEqual([
      join(h, ".claude/output-styles/artifacts-teammate.md"),
    ]);
    expect(r.first).toBe(true);
    const out = readFileSync(file(h), "utf8");
    const m = /^---\n[\s\S]*?\n---\n/.exec(out) as RegExpExecArray;
    // The frontmatter is the source's, byte for byte, and parses as before.
    expect(m[0]).toBe(/^---\n[\s\S]*?\n---\n/.exec(SOURCE)?.[0]);
    expect(out.slice(m[0].length).split("\n", 1)[0]).toBe(OUTPUT_STYLE_MARKER);
    expect(out.replace(`${OUTPUT_STYLE_MARKER}\n`, "")).toBe(SOURCE);
  });

  it("never touches settings.json", () => {
    const h = home();
    mkdirSync(join(h, ".claude"), { recursive: true });
    writeFileSync(join(h, ".claude/settings.json"), '{"outputStyle":"x"}\n');
    installOutputStyle({ home: h, text }, ["claude"]);
    expect(readFileSync(join(h, ".claude/settings.json"), "utf8")).toBe(
      '{"outputStyle":"x"}\n',
    );
  });

  it("refreshes our file on a reinstall and says nothing new", () => {
    const h = home();
    installOutputStyle({ home: h, text }, ["claude"]);
    writeFileSync(file(h), `${readFileSync(file(h), "utf8")}\nedited\n`);
    const r = installOutputStyle({ home: h, text }, ["claude"]);
    expect(r.first).toBe(false);
    expect(r.written).toHaveLength(1);
    expect(readFileSync(file(h), "utf8")).not.toContain("edited");
  });

  it("leaves a file without our marker alone, with a note", () => {
    const h = home();
    mkdirSync(join(h, ".claude/output-styles"), { recursive: true });
    writeFileSync(file(h), "my own style\n");
    const r = installOutputStyle({ home: h, text }, ["claude"]);
    expect(readFileSync(file(h), "utf8")).toBe("my own style\n");
    expect(r.written).toEqual([]);
    expect(r.first).toBe(false);
    expect(r.notes.join(" ")).toContain("no Open Artifacts marker");
  });

  it("does not treat a marker outside the line after the frontmatter as ours", () => {
    const h = home();
    mkdirSync(join(h, ".claude/output-styles"), { recursive: true });
    const mine = `---\nname: x\n---\nmine\n${OUTPUT_STYLE_MARKER}\n`;
    writeFileSync(file(h), mine);
    installOutputStyle({ home: h, text }, ["claude"]);
    expect(readFileSync(file(h), "utf8")).toBe(mine);
  });

  it("honors CLAUDE_CONFIG_DIR", () => {
    const h = home();
    const dir = join(h, "elsewhere");
    const r = installOutputStyle(
      { home: h, env: { CLAUDE_CONFIG_DIR: dir }, text },
      ["claude"],
    );
    expect(r.written).toEqual([
      join(dir, "output-styles/artifacts-teammate.md"),
    ]);
    expect(existsSync(join(h, ".claude"))).toBe(false);
  });

  it("writes nothing when Claude Code is not among the harnesses", () => {
    const h = home();
    const r = installOutputStyle({ home: h, text }, ["pi", "codex"]);
    expect(r).toEqual({ written: [], notes: [], first: false });
    expect(existsSync(join(h, ".claude"))).toBe(false);
  });

  it("leaves a symlinked output-styles folder alone", () => {
    const h = home();
    const elsewhere = join(h, "dotfiles-styles");
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(join(h, ".claude"), { recursive: true });
    symlinkSync(elsewhere, join(h, ".claude/output-styles"));
    const r = installOutputStyle({ home: h, text }, ["claude"]);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(r.written).toEqual([]);
    expect(r.notes.join(" ")).toContain("symlink");
  });

  it("leaves a symlinked file alone, even when its target is ours", () => {
    const h = home();
    installOutputStyle({ home: h, text }, ["claude"]);
    const real = join(h, "real.md");
    writeFileSync(real, readFileSync(file(h), "utf8"));
    rmSync(file(h));
    symlinkSync(real, file(h));
    writeFileSync(real, "user's file\n");
    const r = installOutputStyle({ home: h, text }, ["claude"]);
    expect(readFileSync(real, "utf8")).toBe("user's file\n");
    expect(lstatSync(file(h)).isSymbolicLink()).toBe(true);
    expect(r.notes.join(" ")).toContain("symlink");
  });

  it("leaves a broken symlink alone", () => {
    const h = home();
    mkdirSync(join(h, ".claude/output-styles"), { recursive: true });
    symlinkSync(join(h, "missing.md"), file(h));
    const r = installOutputStyle({ home: h, text }, ["claude"]);
    expect(existsSync(join(h, "missing.md"))).toBe(false);
    expect(r.notes.join(" ")).toContain("symlink");
  });
});

describe("uninstallOutputStyle", () => {
  it("removes our file and the folder it leaves empty", () => {
    const h = home();
    installOutputStyle({ home: h, text }, ["claude"]);
    const r = uninstallOutputStyle({ home: h });
    expect(r.written).toEqual([file(h)]);
    expect(existsSync(join(h, ".claude/output-styles"))).toBe(false);
    expect(existsSync(join(h, ".claude"))).toBe(true);
  });

  it("keeps the folder when anything else is in it", () => {
    const h = home();
    installOutputStyle({ home: h, text }, ["claude"]);
    writeFileSync(join(h, ".claude/output-styles/mine.md"), "mine\n");
    uninstallOutputStyle({ home: h });
    expect(existsSync(file(h))).toBe(false);
    expect(readFileSync(join(h, ".claude/output-styles/mine.md"), "utf8")).toBe(
      "mine\n",
    );
  });

  it("never removes a file without our marker", () => {
    const h = home();
    mkdirSync(join(h, ".claude/output-styles"), { recursive: true });
    writeFileSync(file(h), "my own style\n");
    const r = uninstallOutputStyle({ home: h });
    expect(readFileSync(file(h), "utf8")).toBe("my own style\n");
    expect(r.written).toEqual([]);
    expect(r.notes.join(" ")).toContain("no Open Artifacts marker");
  });

  it("honors CLAUDE_CONFIG_DIR", () => {
    const h = home();
    const env = { CLAUDE_CONFIG_DIR: join(h, "cfg") };
    installOutputStyle({ home: h, env, text }, ["claude"]);
    expect(uninstallOutputStyle({ home: h, env }).written).toHaveLength(1);
    expect(existsSync(join(h, "cfg/output-styles"))).toBe(false);
  });

  it("does nothing when there is no file", () => {
    expect(uninstallOutputStyle({ home: home() })).toEqual({
      written: [],
      notes: [],
    });
  });

  it("does not delete through a symlink", () => {
    const h = home();
    installOutputStyle({ home: h, text }, ["claude"]);
    const real = join(h, "real.md");
    writeFileSync(real, readFileSync(file(h), "utf8"));
    rmSync(file(h));
    symlinkSync(real, file(h));
    uninstallOutputStyle({ home: h });
    expect(existsSync(real)).toBe(true);
    expect(lstatSync(file(h)).isSymbolicLink()).toBe(true);
  });

  it("does not delete through a symlinked folder", () => {
    const h = home();
    const elsewhere = join(h, "dotfiles-styles");
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(join(h, ".claude"), { recursive: true });
    symlinkSync(elsewhere, join(h, ".claude/output-styles"));
    writeFileSync(join(elsewhere, "artifacts-teammate.md"), "x");
    uninstallOutputStyle({ home: h });
    expect(readdirSync(elsewhere)).toEqual(["artifacts-teammate.md"]);
  });
});

describe("outputStyleState", () => {
  it("reports our file, and nothing for a user's file or none", () => {
    const h = home();
    expect(outputStyleState({ home: h })).toBeUndefined();
    installOutputStyle({ home: h, text }, ["claude"]);
    expect(outputStyleState({ home: h })).toEqual({ path: file(h), on: false });
    writeFileSync(file(h), "mine\n");
    expect(outputStyleState({ home: h })).toBeUndefined();
  });
});

// Turning it on: outputStyle in settings.json, only when the key is absent.
const settingsOf = (h: string, dir = join(h, ".claude")) =>
  join(dir, "settings.json");
const recordOf = (h: string) =>
  JSON.parse(readFileSync(join(h, ".oa-bus/install.json"), "utf8")).outputStyle;
const withBus = (h: string, env = {}) => ({
  home: h,
  busHome: join(h, ".oa-bus"),
  env,
  text,
});
const NAME = "Artifacts Teammate";
const put = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
};

describe("turning the style on in settings.json", () => {
  it("sets outputStyle when the key is absent, keeping every other byte", () => {
    const h = home();
    const before = '// mine\n{\n\t"theme": "dark",   "a": [1,2]\n}\n';
    put(settingsOf(h), before);
    const r = installOutputStyle(withBus(h), ["claude"]);
    expect(r.settings).toBe("set");
    const after = readFileSync(settingsOf(h), "utf8");
    expect(JSON.parse(after.replace("// mine", ""))).toEqual({
      theme: "dark",
      a: [1, 2],
      outputStyle: NAME,
    });
    expect(
      after.startsWith('// mine\n{\n\t"theme": "dark",   "a": [1,2]'),
    ).toBe(true);
    expect(recordOf(h)).toMatchObject({
      set: true,
      value: NAME,
      absentBefore: true,
    });
  });

  it("keeps an existing choice, whatever it is", () => {
    for (const v of ['"Explanatory"', '"default"', "null", "7"]) {
      const h = home();
      const before = `{"outputStyle": ${v}}\n`;
      put(settingsOf(h), before);
      const r = installOutputStyle(withBus(h), ["claude"]);
      expect(readFileSync(settingsOf(h), "utf8")).toBe(before);
      expect(r.settings).toBe("kept");
      expect(r.written).toHaveLength(1);
      expect(existsSync(join(h, ".oa-bus/install.json"))).toBe(false);
    }
  });

  it("names the kept style", () => {
    const h = home();
    put(settingsOf(h), '{"outputStyle":"Explanatory"}');
    expect(installOutputStyle(withBus(h), ["claude"]).kept).toBe("Explanatory");
  });

  it("creates a missing settings.json with just the key, and uninstall removes it again", () => {
    const h = home();
    installOutputStyle(withBus(h), ["claude"]);
    expect(JSON.parse(readFileSync(settingsOf(h), "utf8"))).toEqual({
      outputStyle: NAME,
    });
    expect(recordOf(h)).toMatchObject({ set: true, createdFile: true });
    uninstallOutputStyle(withBus(h));
    expect(existsSync(settingsOf(h))).toBe(false);
    expect(recordOf(h)).toBeUndefined();
  });

  it("uninstall restores the file byte for byte", () => {
    const h = home();
    const before = '{\n  // keep\n  "theme": "dark"\n}\n';
    put(settingsOf(h), before);
    installOutputStyle(withBus(h), ["claude"]);
    uninstallOutputStyle(withBus(h));
    expect(readFileSync(settingsOf(h), "utf8")).toBe(before);
    expect(existsSync(file(h))).toBe(false);
  });

  it("uninstall keeps a value the user changed after the install", () => {
    const h = home();
    put(settingsOf(h), '{"theme":"dark"}\n');
    installOutputStyle(withBus(h), ["claude"]);
    put(settingsOf(h), '{"theme":"dark","outputStyle":"Learning"}\n');
    uninstallOutputStyle(withBus(h));
    expect(readFileSync(settingsOf(h), "utf8")).toBe(
      '{"theme":"dark","outputStyle":"Learning"}\n',
    );
    expect(recordOf(h)).toBeUndefined();
  });

  it("uninstall keeps a settings.json the user added keys to", () => {
    const h = home();
    installOutputStyle(withBus(h), ["claude"]);
    put(settingsOf(h), `{"outputStyle":"${NAME}","theme":"dark"}\n`);
    uninstallOutputStyle(withBus(h));
    expect(JSON.parse(readFileSync(settingsOf(h), "utf8"))).toEqual({
      theme: "dark",
    });
  });

  it("a reinstall keeps the record of what we did", () => {
    const h = home();
    installOutputStyle(withBus(h), ["claude"]);
    const r = installOutputStyle(withBus(h), ["claude"]);
    expect(r.settings).toBeUndefined();
    expect(recordOf(h)).toMatchObject({
      set: true,
      absentBefore: true,
      createdFile: true,
    });
    uninstallOutputStyle(withBus(h));
    expect(existsSync(settingsOf(h))).toBe(false);
  });

  it("leaves an unparseable settings.json untouched, with a note", () => {
    const h = home();
    const bad = '{"theme": "dark",, }';
    put(settingsOf(h), bad);
    const r = installOutputStyle(withBus(h), ["claude"]);
    expect(readFileSync(settingsOf(h), "utf8")).toBe(bad);
    expect(r.settings).toBeUndefined();
    expect(r.notes.join(" ")).toContain("settings.json alone");
    expect(r.written).toHaveLength(1);
    expect(existsSync(join(h, ".oa-bus/install.json"))).toBe(false);
  });

  it("leaves a settings.json that is not an object untouched", () => {
    const h = home();
    put(settingsOf(h), "[1]\n");
    installOutputStyle(withBus(h), ["claude"]);
    expect(readFileSync(settingsOf(h), "utf8")).toBe("[1]\n");
  });

  it("leaves a symlinked settings.json untouched", () => {
    const h = home();
    put(join(h, "dotfiles/settings.json"), '{"a":1}\n');
    mkdirSync(join(h, ".claude"), { recursive: true });
    symlinkSync(join(h, "dotfiles/settings.json"), settingsOf(h));
    const r = installOutputStyle(withBus(h), ["claude"]);
    expect(readFileSync(join(h, "dotfiles/settings.json"), "utf8")).toBe(
      '{"a":1}\n',
    );
    expect(lstatSync(settingsOf(h)).isSymbolicLink()).toBe(true);
    expect(r.notes.join(" ")).toContain("symlink");
  });

  it("does not turn it on when the style file is the user's", () => {
    const h = home();
    put(file(h), "my own style\n");
    put(settingsOf(h), "{}\n");
    installOutputStyle(withBus(h), ["claude"]);
    expect(readFileSync(settingsOf(h), "utf8")).toBe("{}\n");
  });

  it("honors CLAUDE_CONFIG_DIR for settings.json and uninstall", () => {
    const h = home();
    const dir = join(h, "cfg");
    const env = { CLAUDE_CONFIG_DIR: dir };
    installOutputStyle(withBus(h, env), ["claude"]);
    expect(JSON.parse(readFileSync(settingsOf(h, dir), "utf8"))).toEqual({
      outputStyle: NAME,
    });
    expect(existsSync(join(h, ".claude"))).toBe(false);
    uninstallOutputStyle(withBus(h, env));
    expect(existsSync(settingsOf(h, dir))).toBe(false);
  });

  it("never edits settings.json when Claude Code is not wired", () => {
    const h = home();
    put(settingsOf(h), "{}\n");
    installOutputStyle(withBus(h), ["pi"]);
    expect(readFileSync(settingsOf(h), "utf8")).toBe("{}\n");
  });

  it("state says on only when settings.json selects it", () => {
    const h = home();
    put(settingsOf(h), '{"outputStyle":"Explanatory"}');
    installOutputStyle(withBus(h), ["claude"]);
    expect(outputStyleState({ home: h })?.on).toBe(false);
    put(settingsOf(h), `{"outputStyle":"${NAME}"}`);
    expect(outputStyleState({ home: h })?.on).toBe(true);
  });
});
