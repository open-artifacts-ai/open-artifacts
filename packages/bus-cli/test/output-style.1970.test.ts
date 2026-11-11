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
  OUTPUT_STYLE_MARKER,
  OUTPUT_STYLE_PLUGIN_NAME,
  outputStyleFile,
  outputStyleOn,
  outputStyleState,
  selectOutputStyle,
  uninstallOutputStyle,
} from "../src/steps/output-style.ts";

const home = () => mkdtempSync(join(tmpdir(), "oa-style-home-"));
const SOURCE = readFileSync(
  join(import.meta.dirname, "../output-style/artifacts-teammate.md"),
  "utf8",
);
const text = SOURCE;
// The file is no longer written (#2095): the plugin carries the style. What runs after the
// plugin is installed is selectOutputStyle, and only when Claude Code is wired.
const installOutputStyle = (
  deps: Parameters<typeof selectOutputStyle>[0] & { text?: string },
  harnesses: string[],
) =>
  harnesses.includes("claude")
    ? selectOutputStyle(deps)
    : { written: [], notes: [] };
// A pre-#2095 install: our marked file, as the old installer wrote it.
const legacyFile = (h: string, env = {}) => {
  const p = file(h, env);
  mkdirSync(join(p, ".."), { recursive: true });
  const end = SOURCE.indexOf("\n---\n", 3) + 5;
  writeFileSync(
    p,
    `${SOURCE.slice(0, end)}${OUTPUT_STYLE_MARKER}\n${SOURCE.slice(end)}`,
  );
  return p;
};
const file = (h: string, env = {}) => outputStyleFile({ home: h, env });

describe("selectOutputStyle (#2095)", () => {
  it("writes no style file: the plugin carries the style", () => {
    const h = home();
    const r = selectOutputStyle({ home: h });
    expect(r.written).toEqual([]);
    expect(existsSync(file(h))).toBe(false);
  });

  it("removes our marked file from an older install, and the folder it leaves empty", () => {
    const h = home();
    legacyFile(h);
    selectOutputStyle({ home: h });
    expect(existsSync(file(h))).toBe(false);
    expect(existsSync(join(h, ".claude/output-styles"))).toBe(false);
  });

  it("keeps a file without our marker and says it may show twice: it is the user's", () => {
    const h = home();
    mkdirSync(join(h, ".claude/output-styles"), { recursive: true });
    writeFileSync(file(h), "my own style\n");
    const r = selectOutputStyle({ home: h });
    expect(readFileSync(file(h), "utf8")).toBe("my own style\n");
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain("so it may be yours");
  });

  it("does not treat a marker outside the line after the frontmatter as ours", () => {
    const h = home();
    mkdirSync(join(h, ".claude/output-styles"), { recursive: true });
    const mine = `---\nname: x\n---\nmine\n${OUTPUT_STYLE_MARKER}\n`;
    writeFileSync(file(h), mine);
    selectOutputStyle({ home: h });
    expect(readFileSync(file(h), "utf8")).toBe(mine);
  });

  it("honors CLAUDE_CONFIG_DIR", () => {
    const h = home();
    const env = { CLAUDE_CONFIG_DIR: join(h, "elsewhere") };
    legacyFile(h, env);
    selectOutputStyle({ home: h, env });
    expect(existsSync(file(h, env))).toBe(false);
    expect(existsSync(join(h, ".claude"))).toBe(false);
  });

  it("leaves a symlinked output-styles folder alone", () => {
    const h = home();
    const elsewhere = join(h, "dotfiles-styles");
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(join(h, ".claude"), { recursive: true });
    symlinkSync(elsewhere, join(h, ".claude/output-styles"));
    writeFileSync(
      join(elsewhere, "artifacts-teammate.md"),
      readFileSync(legacyFile(home()), "utf8"),
    );
    const r = selectOutputStyle({ home: h });
    expect(readdirSync(elsewhere)).toEqual(["artifacts-teammate.md"]);
    expect(r.notes.join(" ")).toContain("symlink");
  });

  it("leaves a symlinked file alone, even when its target is ours", () => {
    const h = home();
    const real = legacyFile(home());
    mkdirSync(join(h, ".claude/output-styles"), { recursive: true });
    symlinkSync(real, file(h));
    const r = selectOutputStyle({ home: h });
    expect(existsSync(real)).toBe(true);
    expect(lstatSync(file(h)).isSymbolicLink()).toBe(true);
    expect(r.notes.join(" ")).toContain("symlink");
  });

  it("moves a value we set to the old name over to the plugin's style", () => {
    const h = home();
    const b = mkdtempSync(join(tmpdir(), "oa-style-bus-"));
    mkdirSync(join(h, ".claude"), { recursive: true });
    legacyFile(h);
    writeFileSync(
      join(h, ".claude/settings.json"),
      '{"outputStyle":"Artifacts Teammate","x":1}\n',
    );
    writeFileSync(
      join(b, "install.json"),
      JSON.stringify({
        outputStyle: {
          set: true,
          value: "Artifacts Teammate",
          before: { state: "absent" },
        },
      }),
    );
    selectOutputStyle({ home: h, busHome: b });
    expect(
      JSON.parse(readFileSync(join(h, ".claude/settings.json"), "utf8"))
        .outputStyle,
    ).toBe(OUTPUT_STYLE_PLUGIN_NAME);
    expect(
      JSON.parse(readFileSync(join(b, "install.json"), "utf8")).outputStyle
        .value,
    ).toBe(OUTPUT_STYLE_PLUGIN_NAME);
  });

  it("leaves the old name alone when our file could not be removed (the user's own file)", () => {
    const h = home();
    mkdirSync(join(h, ".claude/output-styles"), { recursive: true });
    writeFileSync(file(h), "mine\n");
    writeFileSync(
      join(h, ".claude/settings.json"),
      '{"outputStyle":"Artifacts Teammate"}\n',
    );
    selectOutputStyle({
      home: h,
      busHome: mkdtempSync(join(tmpdir(), "oa-style-bus-")),
    });
    expect(readFileSync(join(h, ".claude/settings.json"), "utf8")).toBe(
      '{"outputStyle":"Artifacts Teammate"}\n',
    );
  });
});

describe("uninstallOutputStyle", () => {
  it("removes our file and the folder it leaves empty", () => {
    const h = home();
    legacyFile(h);
    const r = uninstallOutputStyle({ home: h });
    expect(r.written).toEqual([file(h)]);
    expect(existsSync(join(h, ".claude/output-styles"))).toBe(false);
    expect(existsSync(join(h, ".claude"))).toBe(true);
  });

  it("keeps the folder when anything else is in it", () => {
    const h = home();
    legacyFile(h);
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
    legacyFile(h, env);
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
    legacyFile(h);
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
    legacyFile(h);
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
const NAME = OUTPUT_STYLE_PLUGIN_NAME;
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
      before: { state: "absent" },
    });
  });

  it("keeps an existing choice, whatever it is", () => {
    for (const v of ['"Explanatory"', '"default"', "7", "true", "[]"]) {
      const h = home();
      const before = `{"outputStyle": ${v}}\n`;
      put(settingsOf(h), before);
      const r = installOutputStyle(withBus(h), ["claude"]);
      expect(readFileSync(settingsOf(h), "utf8")).toBe(before);
      expect(r.settings).toBe("kept");
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
      before: { state: "absent" },
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

  it("turns the plugin's style on even beside a user's own file of the same name", () => {
    const h = home();
    put(file(h), "my own style\n");
    put(settingsOf(h), "{}\n");
    const r = installOutputStyle(withBus(h), ["claude"]);
    expect(JSON.parse(readFileSync(settingsOf(h), "utf8"))).toEqual({
      outputStyle: NAME,
    });
    expect(readFileSync(file(h), "utf8")).toBe("my own style\n");
    // The unmarked file stays and the person is told it may show twice.
    expect(r.notes.join(" ")).toContain("shows twice in /output-style");
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

  it("outputStyleOn says yes only when settings.json selects the plugin's style", () => {
    const h = home();
    put(settingsOf(h), '{"outputStyle":"Explanatory"}');
    expect(outputStyleOn({ home: h })).toBe(false);
    put(settingsOf(h), `{"outputStyle":"${NAME}"}`);
    expect(outputStyleOn({ home: h })).toBe(true);
  });
});

describe("review fixes (#1985)", () => {
  it("uninstall keeps a settings.json we created once the user has added a comment", () => {
    const h = home();
    installOutputStyle(withBus(h), ["claude"]);
    const mine = `// my notes\n${readFileSync(settingsOf(h), "utf8")}`;
    writeFileSync(settingsOf(h), mine);
    uninstallOutputStyle(withBus(h));
    expect(existsSync(settingsOf(h))).toBe(true);
    expect(readFileSync(settingsOf(h), "utf8")).toContain("// my notes");
    expect(readFileSync(settingsOf(h), "utf8")).not.toContain("outputStyle");
  });

  it("without a record, uninstall never changes outputStyle, whichever name it holds", () => {
    for (const v of ["Artifacts Teammate", NAME, "Explanatory"]) {
      const h = home();
      put(settingsOf(h), `{"a":1,"outputStyle":"${v}"}\n`);
      uninstallOutputStyle(withBus(h));
      expect(readFileSync(settingsOf(h), "utf8")).toBe(
        `{"a":1,"outputStyle":"${v}"}\n`,
      );
    }
  });

  it("with a corrupt install.json, uninstall leaves outputStyle alone", () => {
    const h = home();
    put(settingsOf(h), "{}\n");
    installOutputStyle(withBus(h), ["claude"]);
    writeFileSync(join(h, ".oa-bus/install.json"), "not json");
    uninstallOutputStyle(withBus(h));
    expect(readFileSync(settingsOf(h), "utf8")).toContain("outputStyle");
  });

  it("never sets the key again once we set it and the user removed it", () => {
    const h = home();
    put(settingsOf(h), '{"a":1}\n');
    installOutputStyle(withBus(h), ["claude"]);
    put(settingsOf(h), '{"a":1}\n');
    const r = installOutputStyle(withBus(h), ["claude"]);
    expect(r.settings).toBeUndefined();
    expect(readFileSync(settingsOf(h), "utf8")).toBe('{"a":1}\n');
  });

  it("does not say 'null' for a kept value that is not a style name", () => {
    for (const v of ["7", '"default"', "false"]) {
      const h = home();
      put(settingsOf(h), `{"outputStyle": ${v}}`);
      const r = installOutputStyle(withBus(h), ["claude"]);
      expect(r.settings).toBe("kept");
      expect(r.kept).toBeUndefined();
    }
  });

  it("uses the current config dir for settings.json, not the recorded path", () => {
    const h = home();
    installOutputStyle(withBus(h), ["claude"]);
    const rec = recordOf(h);
    writeFileSync(
      join(h, ".oa-bus/install.json"),
      JSON.stringify({
        outputStyle: { ...rec, file: join(h, "elsewhere.json") },
      }),
    );
    put(join(h, "elsewhere.json"), `{"outputStyle":"${NAME}"}`);
    uninstallOutputStyle(withBus(h));
    expect(readFileSync(join(h, "elsewhere.json"), "utf8")).toContain(
      "outputStyle",
    );
    expect(existsSync(settingsOf(h))).toBe(false);
  });
});

describe("null and empty outputStyle count as unset", () => {
  it("turns ours on over null, an empty string and blanks, and uninstall restores them exactly", () => {
    for (const v of ["null", '""', '"  "']) {
      const h = home();
      const before = `{\n  "a": 1,\n  "outputStyle": ${v},\n  "b": 2\n}\n`;
      put(settingsOf(h), before);
      const r = installOutputStyle(withBus(h), ["claude"]);
      expect(r.settings).toBe("set");
      expect(JSON.parse(readFileSync(settingsOf(h), "utf8")).outputStyle).toBe(
        NAME,
      );
      uninstallOutputStyle(withBus(h));
      expect(readFileSync(settingsOf(h), "utf8")).toBe(before);
      expect(recordOf(h)).toBeUndefined();
    }
  });

  it("restores only while the value is still ours", () => {
    const h = home();
    put(settingsOf(h), '{"outputStyle":null}\n');
    installOutputStyle(withBus(h), ["claude"]);
    put(settingsOf(h), '{"outputStyle":"Learning"}\n');
    uninstallOutputStyle(withBus(h));
    expect(readFileSync(settingsOf(h), "utf8")).toBe(
      '{"outputStyle":"Learning"}\n',
    );
  });

  it("does not set it again over a null the person put back", () => {
    const h = home();
    put(settingsOf(h), '{"outputStyle":null}\n');
    installOutputStyle(withBus(h), ["claude"]);
    put(settingsOf(h), '{"outputStyle":null}\n');
    const r = installOutputStyle(withBus(h), ["claude"]);
    expect(r.settings).toBeUndefined();
    expect(readFileSync(settingsOf(h), "utf8")).toBe('{"outputStyle":null}\n');
  });

  it("keeps an explicit default, and says nothing of a name", () => {
    const h = home();
    put(settingsOf(h), '{"outputStyle":"default"}\n');
    const r = installOutputStyle(withBus(h), ["claude"]);
    expect(r.settings).toBe("kept");
    expect(r.kept).toBeUndefined();
    expect(readFileSync(settingsOf(h), "utf8")).toBe(
      '{"outputStyle":"default"}\n',
    );
  });
});

describe("the key goes only after our file is gone", () => {
  const withOurKey = (h: string) =>
    put(settingsOf(h), `{"a":1,"outputStyle":"${NAME}"}\n`);

  it("keeps outputStyle when the style file is the user's own", () => {
    const h = home();
    put(file(h), "my own style\n");
    withOurKey(h);
    uninstallOutputStyle(withBus(h));
    expect(readFileSync(settingsOf(h), "utf8")).toContain(
      `"outputStyle":"${NAME}"`,
    );
    expect(readFileSync(file(h), "utf8")).toBe("my own style\n");
  });

  it("with our record and a user's own unmarked file, uninstall keeps the file and undoes our setting", () => {
    const h = home();
    put(settingsOf(h), '{"a":1}\n');
    installOutputStyle(withBus(h), ["claude"]);
    expect(readFileSync(settingsOf(h), "utf8")).toContain(NAME);
    put(file(h), "my own style\n");
    uninstallOutputStyle(withBus(h));
    expect(readFileSync(file(h), "utf8")).toBe("my own style\n");
    expect(JSON.parse(readFileSync(settingsOf(h), "utf8"))).toEqual({ a: 1 });
    expect(existsSync(join(h, ".oa-bus/install.json"))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(h, ".oa-bus/install.json"), "utf8"))
        .outputStyle,
    ).toBeUndefined();
  });

  it("keeps outputStyle when the style file is a symlink", () => {
    const h = home();
    put(join(h, "real.md"), "x");
    mkdirSync(join(h, ".claude/output-styles"), { recursive: true });
    symlinkSync(join(h, "real.md"), file(h));
    withOurKey(h);
    uninstallOutputStyle(withBus(h));
    expect(readFileSync(settingsOf(h), "utf8")).toContain("outputStyle");
  });

  it("keeps outputStyle with no record even when our file is already gone", () => {
    const h = home();
    put(settingsOf(h), '{"a":1,"outputStyle":"Artifacts Teammate"}\n');
    uninstallOutputStyle(withBus(h));
    expect(readFileSync(settingsOf(h), "utf8")).toContain("outputStyle");
  });

  it("drops it after removing our file", () => {
    const h = home();
    installOutputStyle(withBus(h), ["claude"]);
    uninstallOutputStyle(withBus(h));
    expect(existsSync(file(h))).toBe(false);
    expect(existsSync(settingsOf(h))).toBe(false);
  });
});
