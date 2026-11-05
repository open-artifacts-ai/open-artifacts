// The skill the installer writes: fetched from the instance, never vendored,
// one file per harness (a marked block in AGENTS.md for Codex). These tests use
// a temp home and a fake fetch, so nothing touches the network.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODEX_BEGIN,
  installSkill,
  SKILL_HEADER,
  skillPathFor,
  uninstallSkill,
  withCodexBlock,
} from "../src/steps/skill.ts";

const home = () => mkdtempSync(join(tmpdir(), "oa-skill-home-"));
const origin = "https://oa.example";

/** A fake instance: the URL it saw, and the text it returns. */
const fakeFetch = (text = "## Open Artifacts\n\nThe skill body.\n") => {
  const urls: string[] = [];
  return {
    urls,
    fetchSkill: async (url: string) => {
      urls.push(url);
      return text;
    },
  };
};

describe("installSkill", () => {
  it("writes the harness's skill with our header, fetched for that harness", async () => {
    const h = home();
    const f = fakeFetch();
    const r = await installSkill(
      { home: h, fetchSkill: f.fetchSkill },
      origin,
      ["claude"],
    );
    const path = skillPathFor({ home: h }, "claude");
    expect(r.written).toEqual([path]);
    expect(f.urls).toEqual([`${origin}/skill.md?harness=claude`]);
    expect(readFileSync(path, "utf8")).toBe(
      `${SKILL_HEADER}\n\n## Open Artifacts\n\nThe skill body.\n`,
    );
  });

  it("is idempotent: a second run leaves the same bytes and one file", async () => {
    const h = home();
    const f = fakeFetch();
    const deps = { home: h, fetchSkill: f.fetchSkill };
    await installSkill(deps, origin, ["pi", "omp"]);
    const path = skillPathFor({ home: h }, "pi");
    const first = readFileSync(path, "utf8");
    await installSkill(deps, origin, ["pi", "omp"]);
    expect(readFileSync(path, "utf8")).toBe(first);
    // pi and omp share one path: one file, written twice at most, never two.
    expect(
      f.urls.filter((u) => u === `${origin}/skill.md?harness=pi`),
    ).toHaveLength(2);
    expect(
      readFileSync(path, "utf8").match(new RegExp(SKILL_HEADER, "g")),
    ).toHaveLength(1);
  });

  it("leaves a file without our header alone, and says so", async () => {
    const h = home();
    const path = skillPathFor({ home: h }, "claude");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "# mine\n");
    const r = await installSkill(
      { home: h, fetchSkill: fakeFetch().fetchSkill },
      origin,
      ["claude"],
    );
    expect(readFileSync(path, "utf8")).toBe("# mine\n");
    expect(r.written).toEqual([]);
    expect(r.notes.join(" ")).toContain("no Open Artifacts header");
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
    expect(existsSync(skillPathFor({ home: h }, "claude"))).toBe(false);
  });

  it("puts Codex's skill in a marked block, replacing it on rerun", async () => {
    const h = home();
    const path = skillPathFor({ home: h }, "codex");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "# My instructions\n\nKeep this.");
    const deps = { home: h, fetchSkill: fakeFetch().fetchSkill };
    await installSkill(deps, origin, ["codex"]);
    await installSkill(deps, origin, ["codex"]);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# My instructions");
    expect(text.match(/BEGIN Open Artifacts skill/g)).toHaveLength(1);
    expect(text.match(/END Open Artifacts skill/g)).toHaveLength(1);
    expect(text).toContain("edits inside are replaced on reinstall");
  });
});

describe("uninstallSkill", () => {
  it("removes our file and our Codex block, and leaves a foreign file alone", async () => {
    const h = home();
    await installSkill(
      { home: h, fetchSkill: fakeFetch().fetchSkill },
      origin,
      ["claude", "codex"],
    );
    const mine = skillPathFor({ home: h }, "claude");
    const agents = skillPathFor({ home: h }, "codex");
    writeFileSync(agents, `# Mine\n\n${readFileSync(agents, "utf8")}`);
    const foreign = skillPathFor({ home: h }, "pi");
    mkdirSync(join(foreign, ".."), { recursive: true });
    writeFileSync(foreign, "# not ours\n");

    const r = uninstallSkill({ home: h }, ["claude", "codex", "pi"]);
    expect(existsSync(mine)).toBe(false);
    expect(readFileSync(agents, "utf8")).toContain("# Mine");
    expect(readFileSync(agents, "utf8")).not.toContain("BEGIN Open Artifacts");
    expect(readFileSync(foreign, "utf8")).toBe("# not ours\n");
    expect(r.notes.join(" ")).toContain("no Open Artifacts header");
  });

  it("never duplicates a block it appended twice", () => {
    const once = withCodexBlock("", "first");
    const twice = withCodexBlock(once, "second");
    expect(twice.match(/BEGIN Open Artifacts skill/g)).toHaveLength(1);
    expect(twice).toContain("second");
    expect(twice).not.toContain("first");
    expect(twice.startsWith(CODEX_BEGIN)).toBe(true);
  });
});
