// The skill the installer writes: fetched from the instance, never vendored,
// one file per harness (a marked block in AGENTS.md for Codex). A temp home and
// a fake fetch, so nothing touches the network.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODEX_BEGIN,
  CODEX_END,
  installSkill,
  SKILL_MARKER,
  skillDir,
  skillFolder,
  uninstallSkill,
  withCodexBlock,
} from "../src/steps/skill.ts";

const home = () => mkdtempSync(join(tmpdir(), "oa-skill-home-"));
const origin = "https://oa.example";

/** A served skill: frontmatter first, as /skill.md really starts. */
const SKILL = `---\nname: open-artifacts-oa-example\nmetadata:\n  version: "1"\n---\n\n# Open Artifacts\n\nBody.\n`;

const fakeFetch = (text = SKILL) => {
  const urls: string[] = [];
  return {
    urls,
    fetchSkill: async (url: string) => {
      urls.push(url);
      return text;
    },
  };
};

const claudeSkill = (h: string) =>
  join(
    skillDir({ home: h }, "claude"),
    "open-artifacts-oa-example",
    "SKILL.md",
  );

describe("installSkill", () => {
  it("writes the skill under its frontmatter name, marker after the frontmatter", async () => {
    const h = home();
    const f = fakeFetch();
    const r = await installSkill(
      { home: h, fetchSkill: f.fetchSkill },
      origin,
      ["claude"],
    );
    const path = claudeSkill(h);
    expect(r.written).toEqual([path]);
    expect(f.urls).toEqual([`${origin}/skill.md?harness=claude`]);
    const text = readFileSync(path, "utf8");
    // Line 1 must be `---`: pi parses frontmatter from the first line.
    expect(text.split("\n")[0]).toBe("---");
    expect(text).toContain(`${SKILL_MARKER}\n`);
    expect(text.indexOf(SKILL_MARKER)).toBeGreaterThan(
      text.indexOf(`\n---\n`, 3),
    );
    expect(skillFolder(text)).toBe("open-artifacts-oa-example");
  });

  it("is idempotent, and pi and omp share one file", async () => {
    const h = home();
    const f = fakeFetch();
    const deps = { home: h, fetchSkill: f.fetchSkill };
    await installSkill(deps, origin, ["pi", "omp"]);
    const path = join(
      skillDir({ home: h }, "pi"),
      "open-artifacts-oa-example",
      "SKILL.md",
    );
    const first = readFileSync(path, "utf8");
    await installSkill(deps, origin, ["pi", "omp"]);
    expect(readFileSync(path, "utf8")).toBe(first);
    expect(first.split(SKILL_MARKER)).toHaveLength(2);
  });

  it("leaves a file without our marker alone, and says so", async () => {
    const h = home();
    const path = claudeSkill(h);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "---\nname: open-artifacts-oa-example\n---\n\nmine\n");
    const r = await installSkill(
      { home: h, fetchSkill: fakeFetch().fetchSkill },
      origin,
      ["claude"],
    );
    expect(readFileSync(path, "utf8")).not.toContain(SKILL_MARKER);
    expect(r.written).toEqual([]);
    expect(r.notes.join(" ")).toContain("no Open Artifacts marker");
  });

  it("skips with a note when there is no instance", async () => {
    const h = home();
    const f = fakeFetch();
    const r = await installSkill(
      { home: h, fetchSkill: f.fetchSkill },
      undefined,
      ["claude"],
    );
    expect(r.written).toEqual([]);
    expect(f.urls).toEqual([]);
    expect(r.notes.join(" ")).toContain("No instance to fetch the skill from");
  });

  it("writes nothing and names the URL when the fetch fails", async () => {
    const h = home();
    const r = await installSkill(
      {
        home: h,
        fetchSkill: async () => {
          throw new Error("offline");
        },
      },
      origin,
      ["claude"],
    );
    expect(r.written).toEqual([]);
    expect(r.failedUrl).toBe(`${origin}/skill.md?harness=claude`);
    expect(existsSync(claudeSkill(h))).toBe(false);
  });

  it("treats a body with no frontmatter as a failed fetch", async () => {
    const h = home();
    const r = await installSkill(
      { home: h, fetchSkill: fakeFetch("<html>nope</html>").fetchSkill },
      origin,
      ["claude"],
    );
    expect(r.failedUrl).toBe(`${origin}/skill.md?harness=claude`);
    expect(existsSync(claudeSkill(h))).toBe(false);
  });

  it("writes through a symlinked SKILL.md and keeps the link", async () => {
    const h = home();
    const path = claudeSkill(h);
    const real = join(h, "real-skill.md");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      real,
      `---\nname: open-artifacts-oa-example\n---\n\n${SKILL_MARKER}\n`,
    );
    symlinkSync(real, path);
    await installSkill(
      { home: h, fetchSkill: fakeFetch().fetchSkill },
      origin,
      ["claude"],
    );
    expect(readFileSync(real, "utf8")).toContain("Body.");
    expect(existsSync(path)).toBe(true);
  });

  it("puts Codex's skill in a marked block, replacing it on rerun", async () => {
    const h = home();
    const path = join(h, ".codex", "AGENTS.md");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "# My instructions\n\nKeep this.");
    const deps = { home: h, fetchSkill: fakeFetch().fetchSkill };
    await installSkill(deps, origin, ["codex"]);
    await installSkill(deps, origin, ["codex"]);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# My instructions");
    expect(text.split(CODEX_BEGIN)).toHaveLength(2);
    expect(text.split(CODEX_END)).toHaveLength(2);
  });

  it("leaves a Codex block with no END alone, and says so", async () => {
    const h = home();
    const path = join(h, ".codex", "AGENTS.md");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${CODEX_BEGIN}\nold\n`);
    const r = await installSkill(
      { home: h, fetchSkill: fakeFetch().fetchSkill },
      origin,
      ["codex"],
    );
    expect(readFileSync(path, "utf8")).toBe(`${CODEX_BEGIN}\nold\n`);
    expect(r.notes.join(" ")).toContain("no END marker");
  });
});

describe("uninstallSkill", () => {
  it("removes our files for every harness, our Codex block, and nothing foreign", async () => {
    const h = home();
    await installSkill(
      { home: h, fetchSkill: fakeFetch().fetchSkill },
      origin,
      ["claude", "codex"],
    );
    const mine = claudeSkill(h);
    const agents = join(h, ".codex", "AGENTS.md");
    writeFileSync(agents, `# Mine\n\n${readFileSync(agents, "utf8")}`);
    const foreign = join(skillDir({ home: h }, "pi"), "theirs", "SKILL.md");
    mkdirSync(join(foreign, ".."), { recursive: true });
    writeFileSync(foreign, "---\nname: theirs\n---\n");

    uninstallSkill({ home: h });
    expect(existsSync(mine)).toBe(false);
    expect(readFileSync(agents, "utf8")).toContain("# Mine");
    expect(readFileSync(agents, "utf8")).not.toContain(CODEX_BEGIN);
    expect(readFileSync(foreign, "utf8")).toContain("theirs");
  });

  it("never duplicates a block it appended twice", () => {
    const once = withCodexBlock("", "first");
    const twice = withCodexBlock(once, "second");
    expect(twice.split(CODEX_BEGIN)).toHaveLength(2);
    expect(twice).toContain("second");
    expect(twice).not.toContain("first");
  });
});
