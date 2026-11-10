// #1963: Codex 0.76+ gets the skill as a file under $CODEX_HOME/skills; older
// or unreadable versions keep the marked block in AGENTS.md.
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
  CODEX_END,
  codexSkillFile,
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
