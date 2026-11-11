// #2106: --help, harness states in --check, the omp note, and purge removing what install made.
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
import { parse } from "../src/index.ts";
import { main } from "../src/main.ts";
import { habitsQuestion, habitsQuestionLines } from "../src/steps/habits.ts";
import {
  leftoverTargets,
  noteMade,
  readMade,
  removeMade,
} from "../src/steps/leftovers.ts";
import { fakeCtx } from "./fake.ts";

describe("--help", () => {
  it("parses --help, -h and help, ahead of any other flag", () => {
    for (const argv of [
      ["--help"],
      ["-h"],
      ["help"],
      ["install", "--help"],
      ["uninstall", "-h", "--purge"],
    ])
      expect(parse(argv)).toMatchObject({ cmd: "help" });
  });

  it("lists every command and flag, and exits 0", async () => {
    for (const argv of [["--help"], ["-h"], ["help"]]) {
      const ctx = fakeCtx();
      expect(await main(argv, () => ctx)).toBe(0);
      const text = ctx.all().join("\n");
      for (const word of [
        "install",
        "login",
        "uninstall",
        "status",
        "doctor",
        "--instance",
        "--check",
        "--habits",
        "--no-habits",
        "--json",
        "--purge",
        "--home",
        "--no-service",
        "--no-open",
      ])
        expect(text).toContain(word);
      expect(ctx.err()).toEqual([]);
    }
  });
});

describe("habits question", () => {
  it("says omp is not supported yet", () => {
    const q = habitsQuestion(["~/.claude/CLAUDE.md"]);
    expect(q.note).toBe("omp: not supported yet");
    expect(habitsQuestionLines(q)).toContain("  omp: not supported yet");
  });
});

describe("uninstall --purge removes what install made", () => {
  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), "ob-left-"));
    const deps = { home, env: {}, busHome: join(home, ".oa-bus") };
    mkdirSync(deps.busHome, { recursive: true });
    return { home, deps };
  };
  const put = (path: string, text: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  };

  it("deletes recorded files that are empty or {} and recorded empty folders", () => {
    const { home, deps } = setup();
    const t = leftoverTargets(deps);
    noteMade(deps);
    const agents = join(home, ".codex/AGENTS.md");
    const cli = join(home, ".config/opencode/cli.json");
    const skills = join(home, ".claude/skills");
    put(agents, "");
    put(cli, "{}\n");
    mkdirSync(skills, { recursive: true });
    const gone = removeMade(readMade(join(deps.busHome, "install.json")));
    expect(gone).toEqual(expect.arrayContaining([agents, cli, skills]));
    expect(existsSync(agents)).toBe(false);
    expect(existsSync(cli)).toBe(false);
    expect(existsSync(skills)).toBe(false);
    expect(t.dirs.length).toBeGreaterThan(5);
  });

  it("keeps anything with the user's content, and anything that was there before install", () => {
    const { home, deps } = setup();
    const before = join(home, ".codex/config.toml");
    put(before, "");
    noteMade(deps);
    const agents = join(home, ".codex/AGENTS.md");
    const oc = join(home, ".config/opencode/opencode.json");
    const skills = join(home, ".claude/skills");
    put(agents, "# mine\n");
    put(oc, '{"theme":"x"}');
    put(join(skills, "mine/SKILL.md"), "mine");
    expect(removeMade(readMade(join(deps.busHome, "install.json")))).toEqual(
      [],
    );
    for (const f of [before, agents, oc, join(skills, "mine/SKILL.md")])
      expect(existsSync(f)).toBe(true);
  });

  it("a rerun of noteMade does not claim files that exist by then", () => {
    const { home, deps } = setup();
    noteMade(deps);
    put(join(home, ".codex/AGENTS.md"), "");
    noteMade(deps);
    expect(readMade(join(deps.busHome, "install.json"))).toContain(
      join(home, ".codex/AGENTS.md"),
    );
    const recorded = JSON.parse(
      readFileSync(join(deps.busHome, "install.json"), "utf8"),
    );
    expect(Array.isArray(recorded.made)).toBe(true);
  });
});

describe("uninstall --purge, end to end", () => {
  it("removes the empty files install made and keeps the user's, and names the machines page", async () => {
    const { uninstall } = await import("../src/commands/uninstall.ts");
    const ctx = fakeCtx();
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(
      join(ctx.home, "machine.json"),
      JSON.stringify({
        hub: "https://bus.example.com",
        token: "t",
        label: "box",
      }),
    );
    const deps = { home: ctx.userHome, env: ctx.env, busHome: ctx.home };
    noteMade(deps);
    const agents = join(ctx.userHome, ".codex/AGENTS.md");
    const config = join(ctx.userHome, ".codex/config.toml");
    mkdirSync(join(ctx.userHome, ".codex"), { recursive: true });
    writeFileSync(agents, "");
    writeFileSync(config, "model = 'x'\n");
    expect(await uninstall({ purge: true }, ctx)).toBe(0);
    expect(existsSync(agents)).toBe(false);
    expect(existsSync(config)).toBe(true);
    expect(existsSync(ctx.home)).toBe(false);
  });
});

describe("a habits-only run", () => {
  it("writes no install.json (no record of what install made)", async () => {
    const { install } = await import("../src/commands/install.ts");
    const ctx = fakeCtx();
    mkdirSync(ctx.home, { recursive: true });
    expect(await install({ habits: "show" }, ctx)).toBe(0);
    expect(existsSync(join(ctx.home, "install.json"))).toBe(false);
  });
});
