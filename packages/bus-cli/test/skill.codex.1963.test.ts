// #1963: Codex 0.76+ gets the skill as a file under $CODEX_HOME/skills; older
// or unreadable versions keep the marked block in AGENTS.md.
import {
  chmodSync,
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
import { readCodexVersion } from "../src/steps/codex.ts";
import {
  CODEX_BEGIN,
  CODEX_END,
  codexSkillFile,
  codexSkillState,
  installSkill,
  SKILL_MARKER,
  uninstallSkill,
} from "../src/steps/skill.ts";

const origin = "https://oa.example";
const SKILL = `---\nname: open-artifacts-oa-example\nmetadata:\n  version: "1"\n---\n\n# Open Artifacts\n\nBody mcp__oa_bus__send_message.\n`;
const fetchSkill = async () => SKILL;
const mk = () => mkdtempSync(join(tmpdir(), "oa-skill-1963-"));
const agents = (h: string) => join(h, ".codex", "AGENTS.md");
const USER = "# Mine\n\nKeep this exactly.\n\n  trailing indent\n";

const withAgents = (h: string, text: string) => {
  mkdirSync(join(h, ".codex"), { recursive: true });
  writeFileSync(agents(h), text);
};
const block = `${CODEX_BEGIN}\nold skill\n${CODEX_END}\n`;

describe("Codex skill placement by version (#1963)", () => {
  it("0.76: writes the file with our marker and removes only our block", async () => {
    const h = mk();
    withAgents(h, `${USER}\n${block}`);
    const r = await installSkill(
      { home: h, codexVersion: "0.76.0", fetchSkill },
      origin,
      ["codex"],
    );
    const file = codexSkillFile({ home: h }, "open-artifacts-oa-example");
    expect(file).toBe(
      join(h, ".codex", "skills", "open-artifacts-oa-example", "SKILL.md"),
    );
    const text = readFileSync(file, "utf8");
    expect(text).toContain(SKILL_MARKER);
    expect(text).toContain("mcp__oa_bus__send_message");
    expect(readFileSync(agents(h), "utf8")).toBe(USER);
    expect(r.written).toContain(file);
  });

  it("0.75: keeps today's AGENTS.md block and writes no file", async () => {
    const h = mk();
    withAgents(h, USER);
    await installSkill(
      { home: h, codexVersion: "0.75.9", fetchSkill },
      origin,
      ["codex"],
    );
    expect(readFileSync(agents(h), "utf8")).toContain(CODEX_BEGIN);
    expect(existsSync(join(h, ".codex", "skills"))).toBe(false);
  });

  it("unreadable version: keeps the AGENTS.md block", async () => {
    const h = mk();
    await installSkill({ home: h, fetchSkill }, origin, ["codex"]);
    expect(readFileSync(agents(h), "utf8")).toContain(CODEX_BEGIN);
    expect(existsSync(join(h, ".codex", "skills"))).toBe(false);
  });

  it("honors CODEX_HOME", async () => {
    const h = mk();
    const ch = join(mk(), "elsewhere");
    await installSkill(
      { home: h, env: { CODEX_HOME: ch }, codexVersion: "0.80.0", fetchSkill },
      origin,
      ["codex"],
    );
    expect(
      existsSync(join(ch, "skills", "open-artifacts-oa-example", "SKILL.md")),
    ).toBe(true);
    expect(existsSync(join(h, ".codex"))).toBe(false);
  });

  it("a foreign SKILL.md at our path is left alone, with a note, and the block stays", async () => {
    const h = mk();
    const file = codexSkillFile({ home: h }, "open-artifacts-oa-example");
    mkdirSync(join(file, ".."), { recursive: true });
    const theirs = "---\nname: open-artifacts-oa-example\n---\nmine\n";
    writeFileSync(file, theirs);
    withAgents(h, `${USER}\n${block}`);
    const r = await installSkill(
      { home: h, codexVersion: "0.76.0", fetchSkill },
      origin,
      ["codex"],
    );
    expect(readFileSync(file, "utf8")).toBe(theirs);
    expect(r.notes.join(" ")).toContain(`Left ${file} alone`);
    expect(readFileSync(agents(h), "utf8")).toContain(CODEX_BEGIN);
  });

  it("a block with no END is left alone while the file is still written", async () => {
    const h = mk();
    withAgents(h, `${CODEX_BEGIN}\nold\n`);
    const r = await installSkill(
      { home: h, codexVersion: "0.76.0", fetchSkill },
      origin,
      ["codex"],
    );
    expect(readFileSync(agents(h), "utf8")).toBe(`${CODEX_BEGIN}\nold\n`);
    expect(r.notes.join(" ")).toContain("no END marker");
  });

  it("re-install is idempotent", async () => {
    const h = mk();
    const deps = { home: h, codexVersion: "0.76.0", fetchSkill };
    await installSkill(deps, origin, ["codex"]);
    const file = codexSkillFile({ home: h }, "open-artifacts-oa-example");
    const once = readFileSync(file, "utf8");
    await installSkill(deps, origin, ["codex"]);
    expect(readFileSync(file, "utf8")).toBe(once);
    expect(existsSync(agents(h))).toBe(false);
  });

  it("uninstall removes our file and block, nothing else", async () => {
    const h = mk();
    withAgents(h, `${USER}\n${block}`);
    await installSkill(
      { home: h, codexVersion: "0.76.0", fetchSkill },
      origin,
      ["codex"],
    );
    withAgents(h, `${USER}\n${block}`); // an older block is back
    const other = join(h, ".codex", "skills", "theirs", "SKILL.md");
    mkdirSync(join(other, ".."), { recursive: true });
    writeFileSync(other, "---\nname: theirs\n---\n");
    const r = uninstallSkill({ home: h }, ["codex"]);
    const file = codexSkillFile({ home: h }, "open-artifacts-oa-example");
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(file, ".."))).toBe(false);
    expect(readFileSync(agents(h), "utf8")).toBe(USER);
    expect(existsSync(other)).toBe(true);
    expect(r.written).toContain(file);
  });

  it("uninstall leaves a foreign file at our path", () => {
    const h = mk();
    const file = codexSkillFile({ home: h }, "open-artifacts-x");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "---\nname: open-artifacts-x\n---\nmine\n");
    const r = uninstallSkill({ home: h }, ["codex"]);
    expect(readFileSync(file, "utf8")).toContain("mine");
    expect(r.notes.join(" ")).toContain(`Left ${file} alone`);
  });

  it("uninstall keeps a user's edit byte for byte in AGENTS.md, CRLF included", () => {
    const h = mk();
    const crlf = "# Mine\r\n\r\nline\r\n";
    withAgents(h, `${crlf}\r\n${CODEX_BEGIN}\r\nx\r\n${CODEX_END}\r\n`);
    uninstallSkill({ home: h }, ["codex"]);
    expect(readFileSync(agents(h), "utf8")).toBe(crlf);
  });
});

describe("review fixes (#1963)", () => {
  const file = (h: string) =>
    codexSkillFile({ home: h }, "open-artifacts-oa-example");
  const v76 = (h: string) => ({ home: h, codexVersion: "0.76.0", fetchSkill });

  it("M1: never deletes AGENTS.md; a block-only file is written empty", async () => {
    const h = mk();
    await installSkill({ home: h, fetchSkill }, origin, ["codex"]);
    uninstallSkill({ home: h }, ["codex"]);
    expect(readFileSync(agents(h), "utf8")).toBe("");
    // Migration to a file leaves an empty AGENTS.md too.
    const h2 = mk();
    withAgents(h2, block);
    await installSkill(v76(h2), origin, ["codex"]);
    expect(readFileSync(agents(h2), "utf8")).toBe("");
  });

  it("M1: through a dotfiles symlink the link and its target stay", () => {
    const h = mk();
    const dots = mk();
    const target = join(dots, "AGENTS.md");
    writeFileSync(target, block);
    mkdirSync(join(h, ".codex"), { recursive: true });
    symlinkSync(target, agents(h));
    uninstallSkill({ home: h }, ["codex"]);
    expect(lstatSync(agents(h)).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("");
  });

  it("M2: an unreadable version after a file install keeps the file, no block", async () => {
    const h = mk();
    await installSkill(v76(h), origin, ["codex"]);
    await installSkill({ home: h, fetchSkill }, origin, ["codex"]);
    expect(existsSync(file(h))).toBe(true);
    expect(
      existsSync(agents(h)) ? readFileSync(agents(h), "utf8") : "",
    ).not.toContain(CODEX_BEGIN);
  });

  it("M3: skills folder shared with pi/omp: no file, block kept, note", async () => {
    const h = mk();
    const shared = join(h, ".agents", "skills");
    mkdirSync(shared, { recursive: true });
    mkdirSync(join(h, ".codex"), { recursive: true });
    symlinkSync(shared, join(h, ".codex", "skills"));
    const piFile = join(shared, "open-artifacts-oa-example", "SKILL.md");
    mkdirSync(join(piFile, ".."), { recursive: true });
    writeFileSync(piFile, "pi's own text\n");
    const r = await installSkill(v76(h), origin, ["codex"]);
    expect(readFileSync(piFile, "utf8")).toBe("pi's own text\n");
    expect(readFileSync(agents(h), "utf8")).toContain(CODEX_BEGIN);
    expect(r.notes.join(" ")).toContain("pi and omp");
  });

  it("L1: a downgrade brings the block back and removes our file", async () => {
    const h = mk();
    await installSkill(v76(h), origin, ["codex"]);
    await installSkill(
      { home: h, codexVersion: "0.75.0", fetchSkill },
      origin,
      ["codex"],
    );
    expect(existsSync(file(h))).toBe(false);
    expect(readFileSync(agents(h), "utf8")).toContain(CODEX_BEGIN);
  });

  it("L2: a broken or edited block means no skill file and the note", async () => {
    for (const bad of [
      `${CODEX_BEGIN}\nold\n`,
      `<!-- BEGIN Open Artifacts skill (edited) -->\nold\n${CODEX_END}\n`,
    ]) {
      const h = mk();
      withAgents(h, bad);
      const r = await installSkill(v76(h), origin, ["codex"]);
      expect(existsSync(file(h))).toBe(false);
      expect(readFileSync(agents(h), "utf8")).toBe(bad);
      expect(r.notes.join(" ")).toContain("Fix or remove the block");
    }
  });

  it("L3: every block of ours goes", () => {
    const h = mk();
    withAgents(h, `a\n\n${block}\nmid\n\n${block}`);
    uninstallSkill({ home: h }, ["codex"]);
    expect(readFileSync(agents(h), "utf8")).toBe("a\n\nmid\n");
  });

  it("L4: the blank before a mid-file block stays; no dangling CR", () => {
    const h = mk();
    withAgents(h, `a\n\n${block}b\n`);
    uninstallSkill({ home: h }, ["codex"]);
    expect(readFileSync(agents(h), "utf8")).toBe("a\n\nb\n");
    const h2 = mk();
    withAgents(h2, `a\r\n${CODEX_BEGIN}\r\nx\r\n${CODEX_END}`);
    uninstallSkill({ home: h2 }, ["codex"]);
    expect(readFileSync(agents(h2), "utf8")).toBe("a\r\n");
  });

  it.skipIf(process.getuid?.() === 0)(
    "L5: a failing AGENTS.md cleanup keeps the file in written and names AGENTS.md",
    async () => {
      const h = mk();
      withAgents(h, block);
      mkdirSync(join(h, ".codex", "skills", "open-artifacts-oa-example"), {
        recursive: true,
      });
      chmodSync(join(h, ".codex"), 0o500);
      try {
        const r = await installSkill(v76(h), origin, ["codex"]);
        expect(r.written).toContain(file(h));
        expect(r.notes.join(" ")).toContain(`Could not update ${agents(h)}`);
        expect(existsSync(file(h))).toBe(true);
      } finally {
        chmodSync(join(h, ".codex"), 0o700);
      }
    },
  );

  it("L6: the version comes from the configured Codex command", async () => {
    const dir = mk();
    const bin = join(dir, "mycodex");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    const cfg = join(dir, "bin.json");
    writeFileSync(cfg, JSON.stringify({ bin }));
    const seen: string[] = [];
    const v = await readCodexVersion({
      configFile: cfg,
      exec: async (cmd) => {
        seen.push(cmd);
        return { code: 0, stdout: "codex-cli 0.80.1\n" };
      },
    });
    expect(seen).toEqual([bin]);
    expect(v).toBe("0.80.1");
  });

  it("doctor state: file, block, or both", async () => {
    const h = mk();
    await installSkill(v76(h), origin, ["codex"]);
    expect(codexSkillState({ home: h })).toEqual({
      file: file(h),
      shared: false,
    });
    withAgents(h, block);
    expect(codexSkillState({ home: h })).toEqual({
      file: file(h),
      block: agents(h),
      shared: false,
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    "H1: an unreadable AGENTS.md is never overwritten, in either mode",
    async () => {
      for (const codexVersion of ["0.76.0", "0.75.0", undefined]) {
        const h = mk();
        withAgents(h, "# private\n");
        chmodSync(agents(h), 0o000);
        try {
          const r = await installSkill(
            { home: h, codexVersion, fetchSkill },
            origin,
            ["codex"],
          );
          expect(r.notes.join(" ")).toContain(`Left ${agents(h)} alone`);
          expect(existsSync(file(h))).toBe(false);
          chmodSync(agents(h), 0o600);
          expect(readFileSync(agents(h), "utf8")).toBe("# private\n");
        } finally {
          chmodSync(agents(h), 0o600);
        }
      }
    },
  );

  it("L-a: a dangling skills link to ~/.agents/skills counts as shared", async () => {
    const h = mk();
    mkdirSync(join(h, ".codex"), { recursive: true });
    symlinkSync(join(h, ".agents", "skills"), join(h, ".codex", "skills"));
    const r = await installSkill(v76(h), origin, ["codex"]);
    expect(existsSync(join(h, ".agents"))).toBe(false);
    expect(readFileSync(agents(h), "utf8")).toContain(CODEX_BEGIN);
    expect(r.notes.join(" ")).toContain("shares its skills folder");
  });

  it("L-b: state says when the folder is shared", async () => {
    const h = mk();
    mkdirSync(join(h, ".agents", "skills"), { recursive: true });
    mkdirSync(join(h, ".codex"), { recursive: true });
    symlinkSync(join(h, ".agents", "skills"), join(h, ".codex", "skills"));
    expect(codexSkillState({ home: h }).shared).toBe(true);
    expect(codexSkillState({ home: mk() }).shared).toBe(false);
  });

  it("L-c: marker lines with leading whitespace count as a broken block", async () => {
    const h = mk();
    const bad = `  ${CODEX_BEGIN}\nold\n${CODEX_END}\n`;
    withAgents(h, bad);
    const r = await installSkill(v76(h), origin, ["codex"]);
    expect(readFileSync(agents(h), "utf8")).toBe(bad);
    expect(existsSync(file(h))).toBe(false);
    expect(r.notes.join(" ")).toContain("Fix or remove the block");
  });
});
