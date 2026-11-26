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
import { describe, expect, it, vi } from "vitest";
import { uninstall } from "../src/commands/uninstall.ts";
import {
  HABITS_BEGIN,
  HABITS_END,
  type HabitsHarness,
  habitsFiles,
  removeHabits,
  removeProjectHabits,
  withoutHabits,
} from "../src/steps/habits.ts";
import { fakeCtx, HUB, LABEL, NS, status, TOKEN } from "./fake.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "ob-habits-"));

const OLD_BLOCK = [
  HABITS_BEGIN,
  "     Remove: `oa-bus install --no-habits`, or delete this block. What it is: open-artifacts.com/docs/bus-installs -->",
  "When you're connected to the Open Artifacts bus:",
  "- old rule",
  HABITS_END,
];
const OLD_TEXT = OLD_BLOCK.join("\n");

describe("withoutHabits: removing old blocks keeps every other byte", () => {
  it("removes a block and its separating blank line, nothing else", () => {
    expect(withoutHabits(`a\n\nb\n\n${OLD_TEXT}\n`)).toBe("a\n\nb\n");
    expect(withoutHabits(`# mine\n\n${OLD_TEXT}\n`)).toBe("# mine\n");
    expect(withoutHabits(`${OLD_TEXT}\n`)).toBe("");
  });

  it("keeps text before and after the block byte for byte", () => {
    const before = `head  \n\n${OLD_TEXT}\ntail without newline`;
    expect(withoutHabits(before)).toBe("head  \n\ntail without newline");
  });

  it("keeps CRLF files CRLF and restores the original text", () => {
    const crlfBlock = OLD_BLOCK.join("\r\n");
    const seeded = `one\r\ntwo\r\n\r\n${crlfBlock}\r\n`;
    expect(withoutHabits(seeded)).toBe("one\r\ntwo\r\n");
  });

  it("uses the recorded `added` separator to undo exact bytes", () => {
    const seeded = `# no trailing newline\n\n${OLD_TEXT}\n`;
    expect(withoutHabits(seeded, "\n\n")).toBe("# no trailing newline");
  });

  it("returns the input untouched when no block is present", () => {
    expect(withoutHabits("# mine\n")).toBe("# mine\n");
  });

  it("refuses a block with no END", () => {
    expect(() => withoutHabits(`x\n${HABITS_BEGIN}\ny\n`)).toThrow(
      "unterminated",
    );
  });
});

describe("removeHabits across harnesses", () => {
  const cases: [HabitsHarness, Record<string, string>, string][] = [
    ["claude", {}, ".claude/CLAUDE.md"],
    ["claude", { CLAUDE_CONFIG_DIR: "@/cc" }, "cc/CLAUDE.md"],
    ["codex", {}, ".codex/AGENTS.md"],
    ["codex", { CODEX_HOME: "@/cx" }, "cx/AGENTS.md"],
    ["pi", {}, ".pi/agent/AGENTS.md"],
    ["pi", { PI_CODING_AGENT_DIR: "@/pid" }, "pid/AGENTS.md"],
    ["opencode", {}, ".config/opencode/AGENTS.md"],
    ["opencode", { XDG_CONFIG_HOME: "@/xdg" }, "xdg/opencode/AGENTS.md"],
    ["opencode", { OPENCODE_CONFIG_DIR: "@/oc" }, "oc/AGENTS.md"],
  ];

  for (const [h, env, rel] of cases) {
    it(`${h} ${JSON.stringify(env)}: removes old block and preserves user text`, () => {
      const home = tmp();
      const e = Object.fromEntries(
        Object.entries(env).map(([k, v]) => [k, v.replace("@", home)]),
      );
      const deps = { home, env: e };
      const file = join(home, rel);
      expect(habitsFiles(deps, h)[0]).toBe(file);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, `# keep me\n\n${OLD_TEXT}\n`);
      expect(removeHabits(deps).files).toEqual([file]);
      expect(readFileSync(file, "utf8")).toBe("# keep me\n");
    });
  }

  for (const h of ["codex", "pi"] as const) {
    it(`${h}: removes blocks from both AGENTS.override.md and AGENTS.md`, () => {
      const home = tmp();
      const env =
        h === "codex"
          ? { CODEX_HOME: join(home, "d") }
          : { PI_CODING_AGENT_DIR: join(home, "d") };
      mkdirSync(join(home, "d"));
      writeFileSync(
        join(home, "d", "AGENTS.override.md"),
        `mine\n\n${OLD_TEXT}\n`,
      );
      writeFileSync(join(home, "d", "AGENTS.md"), `plain\n\n${OLD_TEXT}\n`);
      expect(removeHabits({ home, env }).files).toHaveLength(2);
      expect(readFileSync(join(home, "d", "AGENTS.override.md"), "utf8")).toBe(
        "mine\n",
      );
      expect(readFileSync(join(home, "d", "AGENTS.md"), "utf8")).toBe(
        "plain\n",
      );
    });
  }

  it("removes through a symlinked file and keeps the symlink", () => {
    const home = tmp();
    const real = join(home, "dotfiles", "CLAUDE.md");
    mkdirSync(join(home, "dotfiles"));
    writeFileSync(real, `dot\n\n${OLD_TEXT}\n`);
    mkdirSync(join(home, ".claude"));
    const link = join(home, ".claude", "CLAUDE.md");
    symlinkSync(real, link);
    expect(removeHabits({ home }).files).toEqual([link]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("dot\n");
  });

  it("deletes a file only when install.json says install created it and it is now empty", () => {
    const home = tmp();
    const busHome = join(home, ".oa-bus");
    mkdirSync(busHome, { recursive: true });
    mkdirSync(join(home, ".claude"));
    const file = join(home, ".claude", "CLAUDE.md");
    writeFileSync(file, `${OLD_TEXT}\n`);
    writeFileSync(
      join(busHome, "install.json"),
      JSON.stringify({
        habits: { files: { [file]: { added: "", created: true } } },
      }),
    );
    expect(removeHabits({ home, busHome }).files).toEqual([file]);
    expect(existsSync(file)).toBe(false);
  });

  it("leaves a file with a BEGIN and no END alone and reports a note", () => {
    const home = tmp();
    mkdirSync(join(home, ".claude"));
    const f = join(home, ".claude", "CLAUDE.md");
    writeFileSync(f, `${HABITS_BEGIN}\nhalf\n`);
    const r = removeHabits({ home });
    expect(r.files).toEqual([]);
    expect(r.notes[0]).toContain("no END marker");
    expect(readFileSync(f, "utf8")).toBe(`${HABITS_BEGIN}\nhalf\n`);
  });
});

describe("removeProjectHabits and uninstall", () => {
  it("deletes recorded created project files and takes back recorded exclude lines", () => {
    const home = tmp();
    const busHome = join(home, ".oa-bus");
    const repo = join(home, "proj");
    const excludeFile = join(repo, ".git", "info", "exclude");
    const projFile = join(repo, "CLAUDE.local.md");
    mkdirSync(busHome, { recursive: true });
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    writeFileSync(projFile, `${OLD_TEXT}\n`);
    writeFileSync(excludeFile, "# user rule\n/CLAUDE.local.md\n");
    writeFileSync(
      join(busHome, "install.json"),
      JSON.stringify({
        habits: {
          project: {
            files: { [projFile]: { added: "", created: true } },
            exclude: [
              { file: excludeFile, line: "/CLAUDE.local.md", for: projFile },
            ],
          },
        },
      }),
    );
    const r = removeProjectHabits({ home, busHome });
    expect(r.files).toEqual([projFile]);
    expect(existsSync(projFile)).toBe(false);
    expect(readFileSync(excludeFile, "utf8")).toBe("# user rule\n");
  });

  it("uninstall removes both global and recorded per-project old blocks", async () => {
    const ctx = fakeCtx({
      which: (c: string) => c === "claude",
      exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })),
      service: {
        kind: "launchd" as const,
        ensure: vi.fn(async () => ({})),
        remove: vi.fn(async () => ({ unit: "launchd" as const })),
        cli: () => ["oa-bus"],
      },
      status: vi.fn(async () =>
        status({ namespaces: [{ namespace: NS, agents: [] }] }),
      ),
    });
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
    // Wire claude to this bus so uninstall unwires it.
    writeFileSync(
      join(ctx.userHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          oa_bus: {
            command: "oa-bus",
            args: ["mcp", "claude"],
            env: { OA_BUS_HOME: ctx.home },
          },
        },
      }),
    );
    const claudeMd = join(ctx.userHome, ".claude", "CLAUDE.md");
    mkdirSync(join(claudeMd, ".."), { recursive: true });
    writeFileSync(claudeMd, `user\n\n${OLD_TEXT}\n`);
    const projFile = join(ctx.userHome, "repo", "CLAUDE.local.md");
    mkdirSync(join(projFile, ".."), { recursive: true });
    writeFileSync(projFile, `${OLD_TEXT}\n`);
    writeFileSync(
      join(ctx.home, "install.json"),
      JSON.stringify({
        habits: {
          project: {
            files: { [projFile]: { added: "", created: true } },
            exclude: [],
          },
        },
      }),
    );
    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(readFileSync(claudeMd, "utf8")).toBe("user\n");
    expect(existsSync(projFile)).toBe(false);
  });
});
