// #3043: habits come from the bus over IPC, never from a habits.on marker file.
// Install, --habits, --no-habits and uninstall never write habits.on, and remove
// any legacy habits.on left behind by earlier versions.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIEF_RULES } from "@oa/bus-protocol";
import { describe, expect, it, vi } from "vitest";
import { habitsLine } from "../src/commands/habits.ts";
import { install } from "../src/commands/install.ts";
import { uninstall } from "../src/commands/uninstall.ts";
import {
  PLUGIN_HARNESSES,
  removeHabits,
  removePluginHabits,
} from "../src/steps/habits.ts";
import {
  HERMES_HABITS_MARKER,
  HERMES_MARKER,
  hermesPluginDir,
  pluginHash,
  pluginState,
} from "../src/steps/hermes.ts";
import { fakeCtx, HUB, LABEL, NS, status, TOKEN } from "./fake.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "ob-habits-plugin-"));
const hermes = PLUGIN_HARNESSES[0] as (typeof PLUGIN_HARNESSES)[number];

/** A plugin folder as the installer leaves it. */
const ours = (home: string, env: Record<string, string> = {}) => {
  const dir = hermesPluginDir(home, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, HERMES_MARKER),
    "managed by the Open Artifacts bus installer: edits are replaced on reinstall. abc\n",
  );
  writeFileSync(join(dir, "bus.py"), "X = 1\n");
  return dir;
};

describe("removePluginHabits: a folder under an env that is gone (#1743)", () => {
  it("reaches a legacy Hermes marker recorded under another HERMES_HOME", () => {
    const home = tmp();
    const busHome = join(home, ".oa-bus");
    const env = { HERMES_HOME: join(tmp(), "srv-hermes") };
    const dir = ours(home, env);
    writeFileSync(join(dir, HERMES_HABITS_MARKER), "on\n");
    mkdirSync(busHome, { recursive: true });
    writeFileSync(
      join(busHome, "install.json"),
      JSON.stringify({ habits: { pluginDirs: { hermes: [dir] } } }),
    );
    const r = removeHabits({ home, busHome });
    expect(r.files).toContain(join(dir, HERMES_HABITS_MARKER));
    expect(existsSync(join(dir, HERMES_HABITS_MARKER))).toBe(false);
  });
});

describe("removePluginHabits", () => {
  it("removes a legacy marker", () => {
    const home = tmp();
    const dir = ours(home);
    writeFileSync(join(dir, HERMES_HABITS_MARKER), "on\n");
    expect(removePluginHabits({ home }, [hermes]).changed).toEqual([hermes]);
    expect(existsSync(join(dir, HERMES_HABITS_MARKER))).toBe(false);
  });
  it.each([
    ["plain", false],
    ["symlinked", true],
  ])("reaches a HERMES_HOME under a %s ~/.hermes", (_name, linked) => {
    const home = tmp();
    const root = linked ? join(tmp(), "hermes") : join(home, ".hermes");
    mkdirSync(root, { recursive: true });
    if (linked) symlinkSync(root, join(home, ".hermes"));
    const env = { HERMES_HOME: join(root, "custom") };
    const dir = ours(home, env);
    writeFileSync(join(dir, HERMES_HABITS_MARKER), "on\n");
    expect(removePluginHabits({ home, env }, [hermes]).changed).toEqual([
      hermes,
    ]);
    expect(existsSync(join(dir, HERMES_HABITS_MARKER))).toBe(false);
  });
  it("removeHabits (--no-habits, uninstall) takes a legacy marker too", () => {
    const home = tmp();
    const dir = ours(home);
    writeFileSync(join(dir, HERMES_HABITS_MARKER), "on\n");
    const r = removeHabits({ home });
    expect(r.files).toEqual([join(dir, HERMES_HABITS_MARKER)]);
    expect(existsSync(join(dir, HERMES_HABITS_MARKER))).toBe(false);
  });
  it("sweeps the root and every profile, and notes a symlinked one", () => {
    const home = tmp();
    const root = join(home, ".hermes");
    const mk = (base: string) => {
      const d = join(base, "plugins", "oa-bus");
      mkdirSync(d, { recursive: true });
      writeFileSync(
        join(d, HERMES_MARKER),
        "managed by the Open Artifacts bus installer: x\n",
      );
      writeFileSync(join(d, HERMES_HABITS_MARKER), "on\n");
      return d;
    };
    const a = mk(root);
    const b = mk(join(root, "profiles", "work"));
    const c = mk(join(root, "profiles", "play"));
    // A foreign folder keeps its marker; a symlinked profile dir is skipped with a note.
    const foreign = join(root, "profiles", "other", "plugins", "oa-bus");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, HERMES_HABITS_MARKER), "mine\n");
    const real = join(home, "real");
    mkdirSync(real);
    writeFileSync(
      join(real, HERMES_MARKER),
      "managed by the Open Artifacts bus installer: x\n",
    );
    writeFileSync(join(real, HERMES_HABITS_MARKER), "on\n");
    const linked = join(root, "profiles", "linked", "plugins", "oa-bus");
    mkdirSync(join(linked, ".."), { recursive: true });
    symlinkSync(real, linked);
    const r = removeHabits({ home });
    for (const d of [a, b, c])
      expect(existsSync(join(d, HERMES_HABITS_MARKER))).toBe(false);
    expect(readFileSync(join(foreign, HERMES_HABITS_MARKER), "utf8")).toBe(
      "mine\n",
    );
    expect(existsSync(join(real, HERMES_HABITS_MARKER))).toBe(true);
    expect(r.notes.join("\n")).toContain(
      `Left the Hermes plugin alone: ${linked} is a symlink, so its habits may still be on. To turn them off, delete ${linked}/habits.on.`,
    );
  });
  it("unlinks a symlinked marker without following it", () => {
    const home = tmp();
    const dir = ours(home);
    const target = join(home, "target");
    writeFileSync(target, "keep");
    symlinkSync(target, join(dir, HERMES_HABITS_MARKER));
    removePluginHabits({ home }, [hermes]);
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(() => lstatSync(join(dir, HERMES_HABITS_MARKER))).toThrow();
  });
  it("a legacy marker does not make the plugin stale or foreign", () => {
    const home = tmp();
    const dir = ours(home);
    const shipped = tmp();
    writeFileSync(join(shipped, "bus.py"), "X = 1\n");
    writeFileSync(
      join(dir, HERMES_MARKER),
      `managed by the Open Artifacts bus installer: edits are replaced on reinstall. ${pluginHash(shipped)}\n`,
    );
    expect(pluginState(dir, shipped)).toBe("current");
    writeFileSync(join(dir, HERMES_HABITS_MARKER), "on\n");
    expect(pluginHash(dir)).toBe(pluginHash(shipped));
    expect(pluginState(dir, shipped)).toBe("current");
  });
});

// Through the commands, with Hermes the only harness.
const hermesOnly = (over = {}) => {
  let enabled = false;
  return {
    which: (c: string) => c === "hermes",
    exec: vi.fn(async (_cmd: string, args: string[]) => {
      if (args[1] === "enable") enabled = true;
      if (args[1] === "list")
        return {
          code: 0,
          stdout: JSON.stringify([
            { name: "oa-bus", status: enabled ? "enabled" : "not enabled" },
          ]),
          stderr: "",
        };
      return { code: 0, stdout: "", stderr: "" };
    }),
    service: {
      kind: "launchd" as const,
      ensure: vi.fn(async () => ({})),
      remove: vi.fn(async () => ({ unit: "launchd" as const })),
      cli: () => ["oa-bus"],
    },
    status: vi.fn(async () =>
      status({ namespaces: [{ namespace: NS, agents: [] }] }),
    ),
    ...over,
  };
};
/** #2966: project habits need a git work tree; this ctx's cwd is its root. */
const asRepo = (ctx: ReturnType<typeof fakeCtx>) => {
  Object.assign(ctx, { cwd: mkdtempSync(join(tmpdir(), "ob-hp-proj-")) });
  const base = ctx.which;
  Object.assign(ctx, { which: (c: string) => c === "git" || base(c) });
  const prev = ctx.exec;
  Object.assign(ctx, {
    exec: vi.fn(async (cmd: string, args: string[], opts?: unknown) => {
      if (cmd !== "git") return prev(cmd, args, opts as never);
      if (args.includes("--show-toplevel"))
        return { code: 0, stdout: `${ctx.cwd}\n`, stderr: "" };
      if (args.includes("--show-prefix"))
        return { code: 0, stdout: "", stderr: "" };
      if (args.includes("--git-path"))
        return {
          code: 0,
          stdout: join(ctx.cwd, ".git", "info", "exclude"),
          stderr: "",
        };
      if (args.includes("ls-files")) return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }),
  });
  return ctx;
};
const setup = (over = {}, tty = false) => {
  const ctx = asRepo(fakeCtx(hermesOnly(over), tty));
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
};
const marker = (ctx: ReturnType<typeof fakeCtx>) =>
  join(hermesPluginDir(ctx.userHome, ctx.env), HERMES_HABITS_MARKER);

describe("install and uninstall with Hermes", () => {
  it("a Hermes-only machine is not asked about habits", async () => {
    const ctx = setup();
    await install({ hub: HUB }, ctx);
    expect(existsSync(marker(ctx))).toBe(false);
    expect(ctx.out().join("\n")).not.toContain("QUESTION FOR YOUR USER");
    expect(habitsLine(ctx)).toBe("Habits: on, sent by the bus");
  });
  it("--habits and install never create habits.on, and remove an existing one", async () => {
    const ctx = setup();
    await install({ hub: HUB }, ctx);
    expect(existsSync(marker(ctx))).toBe(false);
    // --habits never creates habits.on and removes any leftover one quietly.
    writeFileSync(marker(ctx), "on\n");
    const beforeOn = ctx.out().length;
    await install({ habits: "yes" }, ctx);
    expect(existsSync(marker(ctx))).toBe(false);
    const onOut = ctx.out().slice(beforeOn).join("\n");
    expect(onOut).toContain(
      "Habits: on, sent by the bus. Nothing is written to your instruction files.",
    );
    expect(onOut).not.toContain("Habits on in the Hermes plugin.");
    expect(onOut).not.toContain("Bus habits now come with the bus");
    expect(habitsLine(ctx)).toBe("Habits: on, sent by the bus");
    // Reinstall on a current plugin removes any leftover habits.on.
    writeFileSync(marker(ctx), "on\n");
    await install({ hub: HUB }, ctx);
    expect(existsSync(marker(ctx))).toBe(false);
    // Reinstall on a stale plugin does not carry habits.on over.
    writeFileSync(marker(ctx), "on\n");
    writeFileSync(
      join(hermesPluginDir(ctx.userHome, ctx.env), "bus.py"),
      "# edited\n",
    );
    await install({ hub: HUB }, ctx);
    expect(existsSync(marker(ctx))).toBe(false);
    expect(
      readFileSync(
        join(hermesPluginDir(ctx.userHome, ctx.env), "bus.py"),
        "utf8",
      ),
    ).not.toBe("# edited\n");
    // --no-habits removes any leftover marker too.
    writeFileSync(marker(ctx), "on\n");
    await install({ habits: "no" }, ctx);
    expect(existsSync(marker(ctx))).toBe(false);
    await uninstall({ purge: false }, ctx);
    expect(existsSync(hermesPluginDir(ctx.userHome, ctx.env))).toBe(false);
  });
  (process.getuid?.() === 0 ? it.skip : it)(
    "--no-habits that cannot remove a legacy marker says so, exits 1 and never prints Habits off",
    async () => {
      const ctx = setup();
      await install({ hub: HUB }, ctx);
      writeFileSync(marker(ctx), "on\n");
      const dir = hermesPluginDir(ctx.userHome, ctx.env);
      chmodSync(dir, 0o500);
      try {
        const before = ctx.out().length;
        const code = await install({ habits: "no" }, ctx);
        const text = ctx.out().slice(before).join("\n");
        expect(code).toBe(1);
        expect(text).not.toContain("Habits off");
        expect(text).toContain(
          "Habits are still on in some places (see below)",
        );
        expect(text).toContain("habits are still on");
        expect(existsSync(marker(ctx))).toBe(true);
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );
  it("--no-habits is not failed by a harmless symlink at the Hermes plugin path", async () => {
    const ctx = setup();
    await install({ hub: HUB }, ctx);
    const dir = hermesPluginDir(ctx.userHome, ctx.env);
    rmSync(dir, { recursive: true, force: true });
    const empty = join(ctx.userHome, "empty-plugin");
    mkdirSync(empty);
    symlinkSync(empty, dir);
    const code = await install({ habits: "no" }, ctx);
    expect(code).toBe(0);
    expect(ctx.out().join("\n")).toContain("Habits off");
  });
  it("install never prompts for habits, and --no-habits opts out", async () => {
    const readLine = vi.fn(async () => "y");
    const yes = setup({ stdinIsTTY: true, readLine });
    await install({ hub: HUB }, yes);
    expect(existsSync(marker(yes))).toBe(false);
    expect(readLine).not.toHaveBeenCalled();
    const no = setup();
    await install({ habits: "no" }, no);
    expect(existsSync(marker(no))).toBe(false);
    expect(habitsLine(no)).toBe("Habits: off (you opted out)");
  });
  it("--habits unlinks a symlinked leftover marker without following it", async () => {
    const ctx = setup();
    await install({ hub: HUB }, ctx);
    const target = join(ctx.userHome, "t");
    writeFileSync(target, "keep");
    symlinkSync(target, marker(ctx));
    const code = await install({ habits: "yes" }, ctx);
    expect(code).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(() => lstatSync(marker(ctx))).toThrow();
  });
  it("--show-habits prints BRIEF_RULES verbatim and exits 0", async () => {
    const ctx = setup();
    expect(await install({ habits: "show" }, ctx)).toBe(0);
    expect(ctx.raw()).toBe(BRIEF_RULES);
  });
});

describe("off: a symlinked Hermes profiles folder (#1717)", () => {
  const profileDir = (root: string, name: string) =>
    join(root, "profiles", name, "plugins", "oa-bus");
  const withMarker = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, HERMES_MARKER),
      "managed by the Open Artifacts bus installer: x\n",
    );
    writeFileSync(join(dir, HERMES_HABITS_MARKER), "on\n");
  };
  it("says the folder is a link and where it points, and still sweeps it", () => {
    const home = tmp();
    const elsewhere = join(tmp(), "shared-profiles");
    const behind = join(elsewhere, "work", "plugins", "oa-bus");
    withMarker(behind);
    mkdirSync(join(home, ".hermes"), { recursive: true });
    symlinkSync(elsewhere, join(home, ".hermes", "profiles"));
    const r = removePluginHabits({ home }, [hermes]);
    expect(existsSync(join(behind, HERMES_HABITS_MARKER))).toBe(false);
    expect(r.notes).toContain(
      `The Hermes profiles folder ${join(home, ".hermes", "profiles")} is a symlink to ${realpathSync(elsewhere)}. Its profiles were checked too.`,
    );
    expect(r.incomplete).toBe(false);
  });
  it("says nothing about a plain profiles folder", () => {
    const home = tmp();
    withMarker(profileDir(join(home, ".hermes"), "work"));
    const r = removePluginHabits({ home }, [hermes]);
    expect(r.notes).toEqual([]);
    expect(r.incomplete).toBe(false);
  });
  it("says a dangling link has no profiles, without failing the off", () => {
    const home = tmp();
    mkdirSync(join(home, ".hermes"), { recursive: true });
    const gone = join(tmp(), "gone");
    symlinkSync(gone, join(home, ".hermes", "profiles"));
    const r = removePluginHabits({ home }, [hermes]);
    expect(r.notes).toEqual([
      `The Hermes profiles folder ${join(home, ".hermes", "profiles")} is a symlink to ${gone}, which doesn't exist, so there were no profiles to check.`,
    ]);
    expect(r.incomplete).toBe(false);
  });
  it("says nothing when a plain profiles folder is missing", () => {
    const home = tmp();
    mkdirSync(join(home, ".hermes"), { recursive: true });
    const r = removePluginHabits({ home }, [hermes]);
    expect(r.notes).toEqual([]);
    expect(r.incomplete).toBe(false);
  });
  it("says a profiles path that is a file is not a folder", () => {
    const home = tmp();
    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(join(home, ".hermes", "profiles"), "x");
    const r = removePluginHabits({ home }, [hermes]);
    expect(r.notes).toEqual([
      `The Hermes profiles folder ${join(home, ".hermes", "profiles")} isn't a folder, so there were no profiles to check.`,
    ]);
    expect(r.incomplete).toBe(false);
  });
  it("says a link loop could not be read and marks the off incomplete", () => {
    const home = tmp();
    mkdirSync(join(home, ".hermes"), { recursive: true });
    const p = join(home, ".hermes", "profiles");
    symlinkSync(p, p);
    const r = removePluginHabits({ home }, [hermes]);
    expect(r.notes).toEqual([
      `Couldn't read the Hermes profiles folder ${p} (ELOOP), so habits may still be on in a profile there.`,
    ]);
    expect(r.incomplete).toBe(true);
  });
  it.skipIf(process.getuid?.() === 0)(
    "says an unreadable plain profiles folder could not be read",
    () => {
      const home = tmp();
      const p = join(home, ".hermes", "profiles");
      mkdirSync(join(p, "work"), { recursive: true });
      chmodSync(p, 0o000);
      try {
        const r = removePluginHabits({ home }, [hermes]);
        expect(r.notes).toEqual([
          `Couldn't read the Hermes profiles folder ${p} (EACCES), so habits may still be on in a profile there.`,
        ]);
        expect(r.incomplete).toBe(true);
      } finally {
        chmodSync(p, 0o755);
      }
    },
  );
  it("does not throw when the Hermes root is a file", () => {
    const home = tmp();
    writeFileSync(join(home, ".hermes"), "x");
    const r = removePluginHabits({ home }, [hermes]);
    expect(r.notes).toEqual([
      `The Hermes profiles folder ${join(home, ".hermes", "profiles")} isn't a folder, so there were no profiles to check.`,
    ]);
    expect(r.incomplete).toBe(false);
  });
  it.skipIf(process.getuid?.() === 0)(
    "does not throw when the Hermes root cannot be searched",
    () => {
      const home = tmp();
      const root = join(home, ".hermes");
      mkdirSync(join(root, "profiles"), { recursive: true });
      chmodSync(root, 0o000);
      try {
        const r = removePluginHabits({ home }, [hermes]);
        expect(r.notes).toContain(
          `Couldn't read the Hermes profiles folder ${join(root, "profiles")} (EACCES), so habits may still be on in a profile there.`,
        );
        expect(r.incomplete).toBe(true);
      } finally {
        chmodSync(root, 0o755);
      }
    },
  );
});
