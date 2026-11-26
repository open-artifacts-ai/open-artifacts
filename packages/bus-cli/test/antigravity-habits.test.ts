// agy S4: habits and the skill for Antigravity, behind OA_BUS_EXPERIMENTAL_AGY=1.
// A fake agy on PATH (ctx.which), a fake instance and scratch homes only: no
// real agy runs.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessSkills } from "@oa/shared/harness-skills";
import { describe, expect, it, vi } from "vitest";
import { doctor } from "../src/commands/doctor.ts";
import { habitsLine } from "../src/commands/habits.ts";
import { install } from "../src/commands/install.ts";
import { uninstall } from "../src/commands/uninstall.ts";
import type { Ctx } from "../src/context.ts";
import {
  HABITS_BEGIN,
  HABITS_END,
  habitsFiles,
  PROJECT_HABITS_FILE,
} from "../src/steps/habits.ts";
import { SKILL_MARKER, skillDir } from "../src/steps/skill.ts";
import { type Fake, fakeCtx, HUB, LABEL, status, TOKEN } from "./fake.ts";

const BIN = ["/opt/node/bin/node", "/h/.oa-bus/bin/oa-bus.js"];
const ON = { OA_BUS_EXPERIMENTAL_AGY: "1" };
const SKILL = "open-artifacts-oa-test";

const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const read = (path: string) => readFileSync(path, "utf8");

/** A ctx with agy on PATH, approved on HUB; the switch on unless `env` says otherwise. */
function make(
  o: { second?: boolean; env?: Record<string, string>; cwd?: string } = {},
): Fake {
  const ctx = fakeCtx({
    which: (c) => c === "agy" || (o.cwd !== undefined && c === "git"),
    env: o.env ?? { ...ON },
    service: {
      kind: "launchd" as const,
      ensure: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({ unit: "launchd" as const })),
      cli: () => BIN,
      argv: () => BIN,
    },
    status: vi.fn(async () => status()),
    ...(o.cwd !== undefined ? { cwd: o.cwd, exec: repoGit(o.cwd) } : {}),
  });
  if (o.second) ctx.home = join(ctx.userHome, "second-bus");
  mkdirSync(ctx.home, { recursive: true });
  writeFileSync(
    join(ctx.home, "machine.json"),
    JSON.stringify({
      hub: HUB,
      machine_id: "m",
      label: LABEL,
      machine_token: TOKEN,
    }),
    { mode: 0o600 },
  );
  return ctx;
}

/** git answering for a work tree whose top is `root`, nothing tracked. */
const repoGit = (root: string) =>
  vi.fn(async (cmd: string, args: string[]) => {
    if (cmd !== "git") return { code: 0, stdout: "", stderr: "" };
    if (args.includes("--is-inside-work-tree"))
      return { code: 0, stdout: "true\n", stderr: "" };
    if (args.includes("--show-toplevel"))
      return { code: 0, stdout: `${root}\n`, stderr: "" };
    if (args.includes("--show-prefix"))
      return { code: 0, stdout: "", stderr: "" };
    if (args.includes("--git-path"))
      return {
        code: 0,
        stdout: join(root, ".git", "info", "exclude"),
        stderr: "",
      };
    // ls-files --error-unmatch: nothing is tracked.
    return { code: 1, stdout: "", stderr: "" };
  });

const rules = (ctx: Ctx) => join(ctx.userHome, ".gemini/config/AGENTS.md");
const skillFile = (ctx: Ctx) =>
  join(ctx.userHome, ".gemini/config/skills", SKILL, "SKILL.md");
const fetched = (ctx: Ctx) =>
  (ctx.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
    String(c[0]),
  );

describe("Antigravity's files (agy S4)", () => {
  it("rules in ~/.gemini/config/AGENTS.md, skills in ~/.gemini/config/skills, AGENTS.md per project", () => {
    const home = "/h";
    expect(habitsFiles({ home }, "antigravity")).toEqual([
      "/h/.gemini/config/AGENTS.md",
    ]);
    expect(skillDir({ home }, "antigravity")).toBe("/h/.gemini/config/skills");
    expect(PROJECT_HABITS_FILE.antigravity).toBe("AGENTS.md");
    expect(harnessSkills.antigravity.skillPath).toBe(
      "~/.gemini/config/skills/open-artifacts/SKILL.md",
    );
    expect(harnessSkills.antigravity.busToolName("send_message")).toBe(
      'call_mcp_tool(ServerName="oa_bus", ToolName="send_message")',
    );
  });
});

describe("install, doctor, uninstall (agy S4)", () => {
  it("install saves our skill for agy; --habits adds our block; doctor says on for Antigravity; uninstall takes back only ours", async () => {
    const ctx = make();
    // The user's own rules, Gemini CLI's file, and a skill of theirs.
    put(rules(ctx), "# my agy rules\n");
    const gemini = join(ctx.userHome, ".gemini/GEMINI.md");
    put(gemini, "# gemini cli\n");
    const theirs = join(ctx.userHome, ".gemini/config/skills/mine/SKILL.md");
    put(theirs, "---\nname: mine\n---\n\n# mine\n");

    expect(await install({ label: LABEL, hub: HUB }, ctx)).toBe(0);
    expect(fetched(ctx)).toContain(`${HUB}/skill.md?harness=antigravity`);
    const saved = read(skillFile(ctx));
    expect(saved.split("\n")[3]).toBe(SKILL_MARKER);
    // Install alone never writes the block: it asks.
    expect(read(rules(ctx))).toBe("# my agy rules\n");

    expect(await install({ habits: "yes" }, ctx)).toBe(0);
    const on = read(rules(ctx));
    expect(on.startsWith("# my agy rules\n\n")).toBe(true);
    expect(on).toContain(HABITS_BEGIN);
    expect(on).toContain(HABITS_END);
    expect(read(gemini)).toBe("# gemini cli\n");
    expect(habitsLine(ctx)).toBe(
      "Habits: on in ~/.gemini/config/AGENTS.md (Antigravity)",
    );
    await doctor(ctx);
    expect(ctx.all().join("\n")).toContain(
      "Habits: on in ~/.gemini/config/AGENTS.md (Antigravity)",
    );

    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(read(rules(ctx))).toBe("# my agy rules\n");
    expect(existsSync(skillFile(ctx))).toBe(false);
    expect(existsSync(join(skillFile(ctx), ".."))).toBe(false);
    expect(read(theirs)).toBe("---\nname: mine\n---\n\n# mine\n");
    expect(read(gemini)).toBe("# gemini cli\n");
  });

  it("a block install created goes with its file; uninstall works with the switch off", async () => {
    const ctx = make();
    expect(await install({ label: LABEL, hub: HUB }, ctx)).toBe(0);
    expect(await install({ habits: "yes" }, ctx)).toBe(0);
    expect(existsSync(rules(ctx))).toBe(true);
    ctx.env = {};
    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(existsSync(rules(ctx))).toBe(false);
    expect(existsSync(skillFile(ctx))).toBe(false);
  });

  it("--no-habits removes our block and a reinstall leaves it out", async () => {
    const ctx = make();
    put(rules(ctx), "# mine\n");
    await install({ label: LABEL, hub: HUB }, ctx);
    await install({ habits: "yes" }, ctx);
    expect(read(rules(ctx))).toContain(HABITS_BEGIN);
    expect(await install({ habits: "no" }, ctx)).toBe(0);
    expect(read(rules(ctx))).toBe("# mine\n");
    expect(habitsLine(ctx)).toBe("Habits: off (you opted out)");
    expect(await install({ label: LABEL, hub: HUB }, ctx)).toBe(0);
    expect(read(rules(ctx))).toBe("# mine\n");
  });

  it("with the switch off: no skill, no block, and doctor's line names no Antigravity", async () => {
    const ctx = make({ env: {} });
    expect(await install({ label: LABEL, hub: HUB }, ctx)).toBe(0);
    expect(fetched(ctx).some((u) => u.includes("harness=antigravity"))).toBe(
      false,
    );
    expect(existsSync(join(ctx.userHome, ".gemini/config/skills"))).toBe(false);
    // No harness wired: --habits has nowhere to go and says so.
    expect(await install({ habits: "yes" }, ctx)).toBe(1);
    expect(existsSync(rules(ctx))).toBe(false);
    await doctor(ctx);
    expect(ctx.all().join("\n")).not.toContain("Antigravity");
  });

  it("a second bus home (--alongside) writes no skill or block, and its uninstall leaves the main bus's alone", async () => {
    const main = make();
    await install({ label: LABEL, hub: HUB }, main);
    await install({ habits: "yes" }, main);
    const block = read(rules(main));
    const skill = read(skillFile(main));
    const second = make({ second: true });
    Object.assign(second, { userHome: main.userHome });
    second.home = join(main.userHome, "second-bus");
    mkdirSync(second.home, { recursive: true });
    writeFileSync(
      join(second.home, "machine.json"),
      JSON.stringify({
        hub: HUB,
        machine_id: "m2",
        label: LABEL,
        machine_token: TOKEN,
      }),
      { mode: 0o600 },
    );
    expect(
      await install({ label: LABEL, hub: HUB, alongside: true }, second),
    ).toBe(0);
    expect(fetched(second).some((u) => u.includes("harness="))).toBe(false);
    expect(await uninstall({ purge: false }, second)).toBe(0);
    expect(read(rules(main))).toBe(block);
    expect(read(skillFile(main))).toBe(skill);
  });

  it("a second bus home's empty run on a fresh machine writes nothing for agy", async () => {
    const ctx = make({ second: true });
    expect(
      await install({ label: LABEL, hub: HUB, alongside: true }, ctx),
    ).toBe(0);
    expect(existsSync(join(ctx.userHome, ".gemini/config"))).toBe(false);
  });
});

describe("per project (agy S4, #2966)", () => {
  it("--habits-project writes the project's AGENTS.md, doctor there says on for Antigravity, --no-habits-project takes it back", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ob-agy-proj-"));
    const ctx = make({ cwd: repo });
    await install({ label: LABEL, hub: HUB }, ctx);
    expect(await install({ habits: "project" }, ctx)).toBe(0);
    const file = join(repo, "AGENTS.md");
    expect(read(file)).toContain(HABITS_BEGIN);
    // Only the project: agy's global rules file is untouched.
    expect(existsSync(rules(ctx))).toBe(false);
    expect(read(join(repo, ".git/info/exclude"))).toContain("/AGENTS.md");
    expect(habitsLine(ctx)).toMatch(
      /^Habits: on in this project, .*AGENTS\.md \(Antigravity\)$/,
    );
    expect(await install({ habits: "project-off" }, ctx)).toBe(0);
    expect(existsSync(file)).toBe(false);
  });
});
