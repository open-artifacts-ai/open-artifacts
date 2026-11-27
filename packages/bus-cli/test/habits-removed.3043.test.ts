// #3043 slice 2: no habits in files; install/upgrade/daemon remove old blocks
// silently (printing one summary line when blocks came out) and never ask.
import { EventEmitter } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { BRIEF_RULES } from "@oa/bus-protocol";
import { describe, expect, it, vi } from "vitest";
import { daemon } from "../src/commands/daemon.ts";
import { doctor } from "../src/commands/doctor.ts";
import { HABITS_MOVED_LINE } from "../src/commands/habits.ts";
import { install } from "../src/commands/install.ts";
import { status as statusCmd } from "../src/commands/status.ts";
import { parse } from "../src/index.ts";
import {
  HABITS_BEGIN,
  HABITS_END,
  removeHabits,
  removeHabitsBlocks,
} from "../src/steps/habits.ts";
import { fakeCtx, HUB, LABEL, NS, status, TOKEN } from "./fake.ts";

const OLD_BLOCK = [
  HABITS_BEGIN,
  "     Remove: `oa-bus install --no-habits`, or delete this block. What it is: open-artifacts.com/docs/bus-installs -->",
  "When you're connected to the Open Artifacts bus:",
  "- old rule",
  HABITS_END,
];
const OLD_LF = OLD_BLOCK.join("\n");
const OLD_CRLF = OLD_BLOCK.join("\r\n");

const approve = (ctx: ReturnType<typeof fakeCtx>) => {
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
};

const claudeHarness = (over: Record<string, unknown> = {}) => ({
  which: (c: string) => c === "claude",
  exec: vi.fn(async (cmd: string) =>
    cmd === "claude"
      ? { code: 1, stdout: "", stderr: "no" }
      : cmd === "codex"
        ? { code: 0, stdout: "codex-cli 0.118.0\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
  ),
  service: {
    kind: "launchd" as const,
    ensure: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({ unit: "launchd" as const })),
    cli: () => ["oa-bus"],
    argv: () => ["oa-bus"],
  },
  status: vi.fn(async () =>
    status({ namespaces: [{ namespace: NS, agents: [] }] }),
  ),
  ...over,
});

const putFile = (path: string, content: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};

/** Seeds all 4 global harness files (one CRLF) + 1 recorded created project file. */
const seedAllFive = (ctx: ReturnType<typeof fakeCtx>) => {
  const claude = join(ctx.userHome, ".claude", "CLAUDE.md");
  const codex = join(ctx.userHome, ".codex", "AGENTS.md");
  const pi = join(ctx.userHome, ".pi", "agent", "AGENTS.md");
  const opencode = join(ctx.userHome, ".config", "opencode", "AGENTS.md");
  const project = join(ctx.userHome, "proj", "CLAUDE.local.md");

  putFile(claude, `claude before\n\n${OLD_LF}\nclaude after\n`);
  putFile(codex, `codex before\r\n\r\n${OLD_CRLF}\r\ncodex after\r\n`);
  putFile(pi, `pi before\n\n${OLD_LF}\npi after\n`);
  putFile(opencode, `opencode before\n\n${OLD_LF}\nopencode after\n`);
  putFile(project, `${OLD_LF}\n`);

  mkdirSync(ctx.home, { recursive: true });
  writeFileSync(
    join(ctx.home, "install.json"),
    JSON.stringify({
      habits: {
        project: {
          files: { [project]: { added: "", created: true } },
          exclude: [],
        },
      },
    }),
  );

  return {
    claude,
    codex,
    pi,
    opencode,
    project,
    expected: {
      claude: "claude before\n\nclaude after\n",
      codex: "codex before\r\n\r\ncodex after\r\n",
      pi: "pi before\n\npi after\n",
      opencode: "opencode before\n\nopencode after\n",
    },
  };
};

describe("install removes old habit blocks and never asks (#3043)", () => {
  for (const [label, tty] of [
    ["non-TTY", false],
    ["TTY", true],
  ] as const) {
    it(`${label}: removes all 5 blocks, keeps user bytes, never calls readLine`, async () => {
      const readLine = vi.fn(async () => {
        throw new Error("readLine must never be called");
      });
      const ctx = fakeCtx(claudeHarness({ stdinIsTTY: tty, readLine }), tty);
      approve(ctx);
      const seeded = seedAllFive(ctx);

      expect(await install({ hub: HUB }, ctx)).toBe(0);
      expect(readLine).not.toHaveBeenCalled();

      const moved = HABITS_MOVED_LINE(5);
      expect(moved).toBe(
        "Bus habits now come with the bus; removed the old block from 5 files.",
      );
      expect(ctx.out().filter((l) => l === moved)).toHaveLength(1);

      expect(readFileSync(seeded.claude, "utf8")).toBe(seeded.expected.claude);
      expect(readFileSync(seeded.codex, "utf8")).toBe(seeded.expected.codex);
      expect(readFileSync(seeded.pi, "utf8")).toBe(seeded.expected.pi);
      expect(readFileSync(seeded.opencode, "utf8")).toBe(
        seeded.expected.opencode,
      );
      expect(existsSync(seeded.project)).toBe(false);

      for (const f of [
        seeded.claude,
        seeded.codex,
        seeded.pi,
        seeded.opencode,
      ]) {
        expect(readFileSync(f, "utf8")).not.toContain(HABITS_BEGIN);
      }
    });
  }

  it("keeps a symlinked ~/.claude/CLAUDE.md as a symlink and removes only the block", async () => {
    const ctx = fakeCtx(claudeHarness());
    approve(ctx);
    const target = join(ctx.userHome, "dotfiles", "CLAUDE.md");
    putFile(target, `my rules\n\n${OLD_LF}\n`);
    const link = join(ctx.userHome, ".claude", "CLAUDE.md");
    mkdirSync(join(link, ".."), { recursive: true });
    symlinkSync(target, link);

    expect(await install({ hub: HUB }, ctx)).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("my rules\n");
    expect(ctx.out()).toContain(
      "Bus habits now come with the bus; removed the old block from 1 file.",
    );
  });

  it("running install a second time prints no moved line (N=0 prints nothing)", async () => {
    const ctx = fakeCtx(claudeHarness());
    approve(ctx);
    seedAllFive(ctx);

    expect(await install({ hub: HUB }, ctx)).toBe(0);
    const afterFirst = ctx.out().length;
    expect(await install({ hub: HUB }, ctx)).toBe(0);
    const secondOut = ctx.out().slice(afterFirst).join("\n");
    expect(secondOut).not.toContain("Bus habits now come with the bus");
  });

  it("a home with no blocks prints no habits line and asks nothing", async () => {
    const readLine = vi.fn(async () => {
      throw new Error("readLine must never be called");
    });
    const ctx = fakeCtx(claudeHarness({ stdinIsTTY: true, readLine }), true);
    approve(ctx);

    expect(await install({ hub: HUB }, ctx)).toBe(0);
    expect(readLine).not.toHaveBeenCalled();
    expect(ctx.out().join("\n")).not.toContain(
      "Bus habits now come with the bus",
    );
    expect(ctx.out().join("\n")).not.toContain("QUESTION FOR YOUR USER");
  });

  it("--json reports { ok, habits: { state, removed }, question: null }", async () => {
    const ctx = fakeCtx(claudeHarness());
    approve(ctx);
    seedAllFive(ctx);

    expect(await install({ hub: HUB, json: true }, ctx)).toBe(0);
    const payload = JSON.parse(ctx.out().join("\n"));
    expect(payload).toEqual({
      ok: true,
      habits: { state: "on", removed: 5 },
      question: null,
    });
    expect(ctx.err().join("\n")).toContain(HABITS_MOVED_LINE(5));
  });

  it("removes blocks before the restarted daemon's startup hook so the moved line and --json count are not lost", async () => {
    let daemonRemoved = -1;
    const make = () => {
      const ctx = fakeCtx(
        claudeHarness({
          service: {
            kind: "launchd" as const,
            ensure: vi.fn(async () => {
              // Simulates daemon.ts startup removal running during service ensure().
              daemonRemoved = removeHabitsBlocks({
                home: ctx.userHome,
                env: ctx.env,
                busHome: ctx.home,
              }).files.length;
              return {};
            }),
            remove: vi.fn(async () => ({ unit: "launchd" as const })),
            cli: () => ["oa-bus"],
            argv: () => ["oa-bus"],
          },
        }),
      );
      approve(ctx);
      seedAllFive(ctx);
      return ctx;
    };

    const human = make();
    expect(await install({ hub: HUB }, human)).toBe(0);
    expect(daemonRemoved).toBe(0);
    const moved = HABITS_MOVED_LINE(5);
    expect(human.out().filter((l) => l === moved)).toHaveLength(1);

    const asJson = make();
    expect(await install({ hub: HUB, json: true }, asJson)).toBe(0);
    expect(daemonRemoved).toBe(0);
    expect(JSON.parse(asJson.out().join("\n"))).toEqual({
      ok: true,
      habits: { state: "on", removed: 5 },
      question: null,
    });
    expect(asJson.err().filter((l) => l === moved)).toHaveLength(1);
  });

  it("still prints the moved line if a later install step fails", async () => {
    const ctx = fakeCtx(
      claudeHarness({
        service: {
          kind: "launchd" as const,
          ensure: vi.fn(async () => ({ running: 999 })),
          remove: vi.fn(async () => ({ unit: "launchd" as const })),
          cli: () => ["oa-bus"],
          argv: () => ["oa-bus"],
        },
      }),
    );
    approve(ctx);
    seedAllFive(ctx);

    expect(await install({ hub: HUB }, ctx)).toBe(1);
    expect(ctx.out().filter((l) => l === HABITS_MOVED_LINE(5))).toHaveLength(1);
  });

  it("removes blocks from recorded paths even when the env var that chose them is no longer set", () => {
    const ctx = fakeCtx();
    const claude = join(ctx.userHome, ".claude", "CLAUDE.md");
    const customCodex = join(ctx.userHome, "codex-custom", "AGENTS.md");

    putFile(claude, `claude user text\n\n${OLD_LF}\n`);
    putFile(customCodex, `codex custom without newline\n\n${OLD_LF}\n`);

    mkdirSync(ctx.home, { recursive: true });
    const installJson = join(ctx.home, "install.json");
    writeFileSync(
      installJson,
      JSON.stringify({
        habits: {
          files: {
            [claude]: { added: "\n", created: false },
            [customCodex]: { added: "\n\n", created: false },
          },
        },
      }),
    );

    // CODEX_HOME is unset in env.
    const deps = { home: ctx.userHome, env: {}, busHome: ctx.home };
    const first = removeHabits(deps);
    expect(first.files).toEqual([claude, customCodex]);
    expect(first.files).toHaveLength(2);
    expect(first.notes).toEqual([]);
    expect(readFileSync(claude, "utf8")).toBe("claude user text\n");
    expect(readFileSync(customCodex, "utf8")).toBe(
      "codex custom without newline",
    );
    expect(JSON.parse(readFileSync(installJson, "utf8")).habits.files).toEqual(
      {},
    );

    const second = removeHabits(deps);
    expect(second.files).toEqual([]);
    expect(second.notes).toEqual([]);
    expect(readFileSync(claude, "utf8")).toBe("claude user text\n");
    expect(readFileSync(customCodex, "utf8")).toBe(
      "codex custom without newline",
    );
  });

  it("keeps the record of a recorded path that is out of reach, and cleans it once it is back", () => {
    const ctx = fakeCtx();
    const dir = join(ctx.userHome, "codex-away");
    const file = join(dir, "AGENTS.md");
    putFile(file, `away user text\n\n${OLD_LF}\n`);
    mkdirSync(ctx.home, { recursive: true });
    const installJson = join(ctx.home, "install.json");
    writeFileSync(
      installJson,
      JSON.stringify({
        habits: { files: { [file]: { added: "\n\n", created: false } } },
      }),
    );
    const deps = { home: ctx.userHome, env: {}, busHome: ctx.home };
    const aside = `${dir}-aside`;
    renameSync(dir, aside);
    const away = removeHabits(deps);
    expect(away.files).toEqual([]);
    expect(
      Object.keys(JSON.parse(readFileSync(installJson, "utf8")).habits.files),
    ).toEqual([file]);
    renameSync(aside, dir);
    const back = removeHabits(deps);
    expect(back.files).toEqual([file]);
    expect(readFileSync(file, "utf8")).toBe("away user text");
    expect(JSON.parse(readFileSync(installJson, "utf8")).habits.files).toEqual(
      {},
    );
  });
});

describe("daemon start removes old habit blocks (#3043)", () => {
  const startDaemon = async (ctx: ReturnType<typeof fakeCtx>) => {
    const signals = new EventEmitter() as never;
    const run = vi.fn(async () => ({ stop: async () => {} }) as never);
    const done = daemon(ctx, run as never, signals);
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    (signals as unknown as EventEmitter).emit("SIGTERM");
    await done;
  };

  const wiredCtx = () => {
    const ctx = fakeCtx({
      service: {
        ensure: async () => ({}),
        remove: async () => ({}),
        cli: () => ["oa-bus"],
        argv: () => ["oa-bus"],
      },
    });
    approve(ctx);
    // Wire Claude Code to this bus home so wiredTo(ctx) is true.
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
    return ctx;
  };

  it("removes an old block in ~/.claude/CLAUDE.md and logs the moved line once to stderr", async () => {
    const ctx = wiredCtx();
    const claudeMd = join(ctx.userHome, ".claude", "CLAUDE.md");
    putFile(claudeMd, `keep\n\n${OLD_LF}\n`);

    await startDaemon(ctx);

    expect(readFileSync(claudeMd, "utf8")).toBe("keep\n");
    const moved = HABITS_MOVED_LINE(1);
    expect(ctx.err().filter((l) => l === moved)).toHaveLength(1);
  });

  it("prints nothing about habits when no block exists", async () => {
    const ctx = wiredCtx();
    await startDaemon(ctx);
    expect(ctx.err().join("\n")).not.toContain(
      "Bus habits now come with the bus",
    );
  });
});

describe("flags: --show-habits, --no-habits, --habits, removed project flags (#3043)", () => {
  it("--show-habits prints BRIEF_RULES verbatim and writes no file", async () => {
    const ctx = fakeCtx(claudeHarness());
    expect(await install({ habits: "show" }, ctx)).toBe(0);
    expect(ctx.raw()).toBe(BRIEF_RULES);
    expect(existsSync(join(ctx.userHome, ".claude", "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(ctx.home, "install.json"))).toBe(false);
  });

  it("--no-habits sets install.json habits.optedOut true, removes blocks, and prints the off line", async () => {
    const ctx = fakeCtx(claudeHarness());
    approve(ctx);
    const claudeMd = join(ctx.userHome, ".claude", "CLAUDE.md");
    putFile(claudeMd, `mine\n\n${OLD_LF}\n`);

    expect(await install({ habits: "no" }, ctx)).toBe(0);
    const rec = JSON.parse(
      readFileSync(join(ctx.home, "install.json"), "utf8"),
    );
    expect(rec.habits.optedOut).toBe(true);
    expect(readFileSync(claudeMd, "utf8")).toBe("mine\n");
    expect(ctx.out().join("\n")).toContain(
      `Habits off: the bus won't send its rules to your sessions. ${ctx.busCmd} install --habits turns them back on.`,
    );
    expect(ctx.out().join("\n")).toContain(HABITS_MOVED_LINE(1));
  });

  it("--habits clears the opt-out and creates no instruction file", async () => {
    const ctx = fakeCtx(claudeHarness());
    approve(ctx);
    await install({ habits: "no" }, ctx);

    expect(await install({ habits: "yes" }, ctx)).toBe(0);
    const rec = JSON.parse(
      readFileSync(join(ctx.home, "install.json"), "utf8"),
    );
    expect(rec.habits.optedOut).toBe(false);
    expect(ctx.out().join("\n")).toContain(
      "Habits: on, sent by the bus. Nothing is written to your instruction files.",
    );
    for (const rel of [
      ".claude/CLAUDE.md",
      ".codex/AGENTS.md",
      ".pi/agent/AGENTS.md",
      ".config/opencode/AGENTS.md",
    ]) {
      expect(existsSync(join(ctx.userHome, rel))).toBe(false);
    }
  });

  it("parse rejects --habits-project and --no-habits-project as usage errors", () => {
    expect(() => parse(["install", "--habits-project"])).toThrow();
    expect(() => parse(["install", "--no-habits-project"])).toThrow();
  });
});

describe("status and doctor habits line (#3043)", () => {
  it("prints 'Habits: on, sent by the bus' by default and even with an old file block, and 'off (you opted out)' after --no-habits", async () => {
    const make = () => {
      const ctx = fakeCtx(
        claudeHarness({
          fetch: vi.fn(
            async () =>
              new Response(JSON.stringify({ ok: true }), { status: 200 }),
          ),
        }),
      );
      approve(ctx);
      return ctx;
    };

    // Default: on, sent by the bus in doctor; omitted on default status screen (#3328 S1).
    const def = make();
    expect(await statusCmd(def)).toBe(0);
    expect(def.all().join("\n")).not.toContain("Habits:");
    const defDoc = make();
    await doctor(defDoc);
    expect(defDoc.all()).toContain("Habits: on, sent by the bus");

    // Even when an old block still sits in ~/.claude/CLAUDE.md: still "on, sent by the bus", never "on in ...".
    const stale = make();
    putFile(join(stale.userHome, ".claude", "CLAUDE.md"), `x\n\n${OLD_LF}\n`);
    await statusCmd(stale);
    expect(stale.all().join("\n")).not.toContain("Habits:");
    const staleDoc = make();
    putFile(
      join(staleDoc.userHome, ".claude", "CLAUDE.md"),
      `x\n\n${OLD_LF}\n`,
    );
    await doctor(staleDoc);
    expect(staleDoc.all()).toContain("Habits: on, sent by the bus");
    expect(staleDoc.all().join("\n")).not.toContain("Habits: on in");

    // After --no-habits: off (you opted out) in doctor.
    const off = make();
    await install({ habits: "no" }, off);
    const beforeStatus = off.all().length;
    await statusCmd(off);
    expect(off.all().slice(beforeStatus).join("\n")).not.toContain("Habits:");
    const beforeDoc = off.all().length;
    await doctor(off);
    expect(off.all().slice(beforeDoc)).toContain("Habits: off (you opted out)");
  });
});
