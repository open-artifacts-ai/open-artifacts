// The skill the installer writes: fetched from the instance, never vendored,
// one file per harness (a marked block in AGENTS.md for Codex). A temp home and
// a fake fetch, so nothing touches the network.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexHome } from "../src/steps/codex.ts";
import {
  CODEX_BEGIN,
  CODEX_END,
  fetchSkillText,
  installSkill,
  MAX_SKILL_BYTES,
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

  it("is idempotent, and pi and omp share one file under ~/.agents/skills", async () => {
    const h = home();
    const f = fakeFetch();
    const deps = { home: h, fetchSkill: f.fetchSkill };
    expect(skillDir({ home: h }, "pi")).toBe(skillDir({ home: h }, "omp"));
    expect(skillDir({ home: h }, "pi")).toBe(join(h, ".agents", "skills"));
    // Even with the pi agent dir overridden, never ~/.pi/agent/skills.
    expect(
      skillDir({ home: h, env: { PI_CODING_AGENT_DIR: join(h, "p") } }, "pi"),
    ).toBe(join(h, ".agents", "skills"));
    const r = await installSkill(deps, origin, ["pi", "omp"]);
    const path = join(
      skillDir({ home: h }, "pi"),
      "open-artifacts-oa-example",
      "SKILL.md",
    );
    expect(r.written).toEqual([path, path]);
    expect(existsSync(join(h, ".pi"))).toBe(false);
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
    expect(r.notes.join(" ")).toContain(
      "Skipped the skill file: this machine isn't approved",
    );
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
      `---\nname: open-artifacts-oa-example\n---\n${SKILL_MARKER}\n`,
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
    expect(r.notes.join(" ")).toContain(
      "no END marker. Fix or remove the block, then rerun the install.",
    );
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

const okResponse = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Response(body, {
    headers: { "content-type": "text/markdown", ...headers },
  });

describe("skillDir env homes", () => {
  it("resolves CODEX_HOME as the codex adapter does", () => {
    const env = { CODEX_HOME: "~/x" };
    expect(skillDir({ home: "/h", env }, "codex")).toBe(
      join(codexHome("/h", env), "AGENTS.md"),
    );
    const rel = { CODEX_HOME: "rel/dir" };
    expect(skillDir({ home: "/h", env: rel }, "codex")).toBe(
      join(codexHome("/h", rel), "AGENTS.md"),
    );
  });
});

describe("served text validation", () => {
  for (const line of [SKILL_MARKER, CODEX_BEGIN, CODEX_END]) {
    it(`treats a whole line ${line.slice(0, 20)}... as a failed fetch`, async () => {
      const h = home();
      const r = await installSkill(
        {
          home: h,
          fetchSkill: fakeFetch(`${SKILL}\n${line}\n`).fetchSkill,
        },
        origin,
        ["claude"],
      );
      expect(r.failedUrl).toBeDefined();
      expect(existsSync(claudeSkill(h))).toBe(false);
    });
  }

  it("accepts a marker quoted mid-line", async () => {
    const h = home();
    const r = await installSkill(
      {
        home: h,
        fetchSkill: fakeFetch(`${SKILL}\nSee \`${SKILL_MARKER}\` here\n`)
          .fetchSkill,
      },
      origin,
      ["claude"],
    );
    expect(r.failedUrl).toBeUndefined();
  });

  it("refuses a skill name that is not open-artifacts*", async () => {
    const h = home();
    const r = await installSkill(
      {
        home: h,
        fetchSkill: fakeFetch("---\nname: evil\n---\nbody\n").fetchSkill,
      },
      origin,
      ["claude"],
    );
    expect(r.failedUrl).toBeDefined();
  });
});

describe("fetchSkillText", () => {
  it("refuses redirects", async () => {
    let seen: RequestInit | undefined;
    await fetchSkillText(
      (async (_u: unknown, init?: RequestInit) => {
        seen = init;
        return okResponse(SKILL);
      }) as typeof fetch,
      origin,
    );
    expect(seen?.redirect).toBe("error");
  });

  it("rejects a content-length over the cap without reading", async () => {
    let pulled = false;
    const body = new ReadableStream(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    );
    await expect(
      fetchSkillText(
        (async () =>
          okResponse(body, {
            "content-length": String(MAX_SKILL_BYTES + 1),
          })) as typeof fetch,
        origin,
      ),
    ).rejects.toThrow("too large");
    expect(pulled).toBe(false);
  });

  it("stops reading the stream past the cap", async () => {
    let chunks = 0;
    const chunk = new Uint8Array(64 * 1024).fill(97);
    const body = new ReadableStream(
      {
        pull(c) {
          chunks++;
          c.enqueue(chunk);
        },
      },
      { highWaterMark: 0 },
    );
    await expect(
      fetchSkillText((async () => okResponse(body)) as typeof fetch, origin),
    ).rejects.toThrow("too large");
    // Unbounded reading would never end.
    expect(chunks).toBeLessThan(10);
  });
});

describe("ownership and uninstall hardening", () => {
  it("keeps a user skill that quotes the marker in its body", () => {
    const h = home();
    const mine = join(skillDir({ home: h }, "claude"), "my-notes", "SKILL.md");
    mkdirSync(join(mine, ".."), { recursive: true });
    writeFileSync(
      mine,
      `---\nname: my-notes\n---\n\nquote:\n${SKILL_MARKER}\n`,
    );
    const r = uninstallSkill({ home: h });
    expect(existsSync(mine)).toBe(true);
    expect(r.notes.join(" ")).toContain("my-notes");
  });

  it("keeps a marked file whose folder differs from its name", () => {
    const h = home();
    const f = join(skillDir({ home: h }, "claude"), "other", "SKILL.md");
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(
      f,
      `---\nname: open-artifacts-x\n---\n${SKILL_MARKER}\nbody\n`,
    );
    uninstallSkill({ home: h });
    expect(existsSync(f)).toBe(true);
  });

  it("does not follow a symlinked folder", () => {
    const h = home();
    const real = join(h, "elsewhere", "open-artifacts-x");
    mkdirSync(real, { recursive: true });
    writeFileSync(
      join(real, "SKILL.md"),
      `---\nname: open-artifacts-x\n---\n${SKILL_MARKER}\nbody\n`,
    );
    const base = skillDir({ home: h }, "claude");
    mkdirSync(base, { recursive: true });
    symlinkSync(real, join(base, "open-artifacts-x"));
    const r = uninstallSkill({ home: h });
    expect(existsSync(join(real, "SKILL.md"))).toBe(true);
    expect(r.notes.join(" ")).toContain("symlinked folder");
  });

  it("keeps an extra file in our folder (rmdir, never recursive)", async () => {
    const h = home();
    await installSkill(
      { home: h, fetchSkill: fakeFetch().fetchSkill },
      origin,
      ["claude"],
    );
    const extra = join(claudeSkill(h), "..", "notes.txt");
    writeFileSync(extra, "mine");
    uninstallSkill({ home: h });
    expect(existsSync(claudeSkill(h))).toBe(false);
    expect(readFileSync(extra, "utf8")).toBe("mine");
  });

  it("turns a read error (SKILL.md is a directory) into a note and goes on", async () => {
    const h = home();
    const bad = join(skillDir({ home: h }, "claude"), "bad", "SKILL.md");
    mkdirSync(bad, { recursive: true });
    await installSkill(
      { home: h, fetchSkill: fakeFetch().fetchSkill },
      origin,
      ["claude", "codex"],
    );
    const r = uninstallSkill({ home: h });
    expect(r.notes.join(" ")).toContain("EISDIR");
    expect(existsSync(claudeSkill(h))).toBe(false);
    expect(existsSync(join(h, ".codex", "AGENTS.md"))).toBe(false);
  });

  it("turns a Codex read error into a note", () => {
    const h = home();
    mkdirSync(join(h, ".codex", "AGENTS.md"), { recursive: true });
    const r = uninstallSkill({ home: h }, ["codex"]);
    expect(r.notes.join(" ")).toContain("EISDIR");
  });

  it("leaves a broken symlink at the target path alone", async () => {
    const h = home();
    const path = claudeSkill(h);
    mkdirSync(join(path, ".."), { recursive: true });
    symlinkSync(join(h, "missing"), path);
    const r = await installSkill(
      { home: h, fetchSkill: fakeFetch().fetchSkill },
      origin,
      ["claude"],
    );
    expect(r.written).toEqual([]);
    expect(r.notes.join(" ")).toContain("broken symlink");
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(existsSync(join(h, "missing"))).toBe(false);
  });

  it("does not duplicate the Codex block in a CRLF AGENTS.md", async () => {
    const h = home();
    const path = join(h, ".codex", "AGENTS.md");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "# Mine\r\n");
    const deps = { home: h, fetchSkill: fakeFetch().fetchSkill };
    await installSkill(deps, origin, ["codex"]);
    writeFileSync(path, readFileSync(path, "utf8").replace(/\n/g, "\r\n"));
    await installSkill(deps, origin, ["codex"]);
    const text = readFileSync(path, "utf8");
    expect(text.split(CODEX_BEGIN)).toHaveLength(2);
    expect(text.split(CODEX_END)).toHaveLength(2);
  });

  it("matches the marker as a whole line only", () => {
    const h = home();
    const f = join(
      skillDir({ home: h }, "claude"),
      "open-artifacts-x",
      "SKILL.md",
    );
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(
      f,
      `---\nname: open-artifacts-x\n---\nprefix ${SKILL_MARKER}\n`,
    );
    uninstallSkill({ home: h });
    expect(existsSync(f)).toBe(true);
  });
});
