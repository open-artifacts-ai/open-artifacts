// agy S4: the skill for Antigravity, and no habits in any agy file (#3043),
//. The rules reach agy from the plugin's
// SessionStart hook instead (antigravity-rules.test.ts). A fake agy on PATH
// (ctx.which), a fake instance and scratch homes only: no real agy runs.
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
import { install } from "../src/commands/install.ts";
import { status as statusCmd } from "../src/commands/status.ts";
import { uninstall } from "../src/commands/uninstall.ts";
import type { Ctx } from "../src/context.ts";
import { HABITS_HARNESSES } from "../src/steps/habits.ts";
import { leftoverTargets } from "../src/steps/leftovers.ts";
import { SKILL_MARKER, skillDir } from "../src/steps/skill.ts";
import { type Fake, fakeCtx, HUB, LABEL, status, TOKEN } from "./fake.ts";

const BIN = ["/opt/node/bin/node", "/h/.oa-bus/bin/oa-bus.js"];
const SKILL = "open-artifacts-oa-test";

const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const read = (path: string) => readFileSync(path, "utf8");

/** A ctx with agy on PATH, approved on HUB. */
function make(
  o: { second?: boolean; env?: Record<string, string>; cwd?: string } = {},
): Fake {
  const ctx = fakeCtx({
    which: (c) => c === "agy" || (o.cwd !== undefined && c === "git"),
    env: o.env ?? {},
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

const gemini = (ctx: Ctx) => join(ctx.userHome, ".gemini/config/GEMINI.md");

describe("Antigravity's files (agy S4)", () => {
  it("skills in ~/.gemini/config/skills; agy is no habits harness", () => {
    const home = "/h";
    expect(HABITS_HARNESSES).not.toContain("antigravity");
    expect(skillDir({ home }, "antigravity")).toBe("/h/.gemini/config/skills");
    expect(harnessSkills.antigravity.skillPath).toBe(
      "~/.gemini/config/skills/open-artifacts/SKILL.md",
    );
    expect(harnessSkills.antigravity.busToolName("send_message")).toBe(
      'call_mcp_tool(ServerName="oa_bus", ToolName="send_message")',
    );
  });
});

describe("install, uninstall (agy S4, #3043)", () => {
  it("install saves our skill and writes no habits into any agy file, even with --habits", async () => {
    const ctx = make();
    put(rules(ctx), "# my agy rules\n");
    put(gemini(ctx), "# my gemini rules\n");
    const cli = join(ctx.userHome, ".gemini/GEMINI.md");
    put(cli, "# gemini cli\n");
    expect(await install({ label: LABEL, hub: HUB }, ctx)).toBe(0);
    expect(fetched(ctx)).toContain(`${HUB}/skill.md?harness=antigravity`);
    expect(read(skillFile(ctx)).split("\n")[3]).toBe(SKILL_MARKER);
    // --habits writes nothing anywhere: the bus sends the rules.
    expect(await install({ habits: "yes" }, ctx)).toBe(0);
    expect(read(rules(ctx))).toBe("# my agy rules\n");
    expect(read(gemini(ctx))).toBe("# my gemini rules\n");
    expect(read(cli)).toBe("# gemini cli\n");
    expect(ctx.all().join("\n")).not.toContain("(Antigravity)");
  });

  it("uninstall takes our skill out, and the skills folder it emptied", async () => {
    const ctx = make();
    expect(await install({ label: LABEL, hub: HUB }, ctx)).toBe(0);
    ctx.env = {};
    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(existsSync(skillFile(ctx))).toBe(false);
    expect(existsSync(join(skillFile(ctx), ".."))).toBe(false);
    // The skills folder it emptied goes too.
    expect(existsSync(join(ctx.userHome, ".gemini/config/skills"))).toBe(false);
    expect(leftoverTargets({ home: ctx.userHome }).dirs).toContain(
      join(ctx.userHome, ".gemini/config/skills"),
    );
    // A user's own skill keeps the folder, and itself.
    const keep = make();
    put(
      join(keep.userHome, ".gemini/config/skills/mine/SKILL.md"),
      "---\nname: mine\n---\n",
    );
    await install({ label: LABEL, hub: HUB }, keep);
    await uninstall({ purge: false }, keep);
    expect(
      read(join(keep.userHome, ".gemini/config/skills/mine/SKILL.md")),
    ).toBe("---\nname: mine\n---\n");
  });

  it("when agy is absent its folders stay untouched", async () => {
    const ctx = make();
    ctx.which = () => false;
    expect(await install({ label: LABEL, hub: HUB }, ctx)).toBe(0);
    expect(fetched(ctx).some((u) => u.includes("harness=antigravity"))).toBe(
      false,
    );
    expect(existsSync(join(ctx.userHome, ".gemini/config/skills"))).toBe(false);
    await doctor(ctx);
    expect(ctx.all().join("\n")).not.toContain("Antigravity");
  });

  it("a second bus home (--alongside) writes no skill, and its uninstall leaves the main bus's alone", async () => {
    const main = make();
    await install({ label: LABEL, hub: HUB }, main);
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

describe("doctor and status with agy wired (agy S4, #3043)", () => {
  /** The lines `run` prints, and a check that none is the old habits text. */
  const run = async (ctx: Fake, f: (c: Ctx) => Promise<number>) => {
    const n = ctx.all().length;
    await f(ctx);
    const out = ctx.all().slice(n);
    const text = out.join("\n");
    expect(text).not.toContain("not decided");
    expect(text).not.toContain("--habits to add them");
    return out;
  };
  const habits = (out: string[]) => out.filter((l) => l.includes("Habits"));

  it("on: Antigravity wired, and both say the bus sends the habits", async () => {
    const ctx = make();
    expect(await install({ label: LABEL, hub: HUB }, ctx)).toBe(0);
    expect(ctx.all().join("\n")).not.toContain("not decided");
    const doc = await run(ctx, doctor);
    expect(doc.join("\n")).toContain("Antigravity wired");
    expect(habits(doc)).toEqual([
      "Antigravity — Habits: on, sent by the bus",
      "Habits: on, sent by the bus",
    ]);
    // #3328 S1: default status screen omits helper/habits wording.
    expect(habits(await run(ctx, statusCmd))).toEqual([]);
  });

  it("off after --no-habits: Antigravity still wired, both say you opted out", async () => {
    const ctx = make();
    expect(await install({ label: LABEL, hub: HUB }, ctx)).toBe(0);
    await run(ctx, (c) => install({ habits: "no" }, c));
    const doc = await run(ctx, doctor);
    expect(doc.join("\n")).toContain("Antigravity wired");
    expect(habits(doc)).toEqual([
      "Antigravity — Habits: off (you opted out)",
      "Habits: off (you opted out)",
    ]);
    expect(habits(await run(ctx, statusCmd))).toEqual([]);
    // And back on.
    await run(ctx, (c) => install({ habits: "yes" }, c));
    expect(habits(await run(ctx, doctor))).toEqual([
      "Antigravity — Habits: on, sent by the bus",
      "Habits: on, sent by the bus",
    ]);
  });
});
