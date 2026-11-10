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
    expect(r.notes.join(" ")).toContain("not an Open Artifacts");
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
    expect(outputStyleState({ home: h })).toBe(file(h));
    writeFileSync(file(h), "mine\n");
    expect(outputStyleState({ home: h })).toBeUndefined();
  });
});
