// The Hermes plugin's habits (#1602): the plugin adds the lines only while
// <plugin dir>/habits.on exists, and the installer writes it only on a yes.
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
import { describe, expect, it, vi } from "vitest";
import { habitsLine } from "../src/commands/habits.ts";
import { install } from "../src/commands/install.ts";
import { uninstall } from "../src/commands/uninstall.ts";
import {
  PLUGIN_HARNESSES,
  pluginHabitsState,
  removeHabits,
  setPluginHabits,
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

describe("setPluginHabits: a folder under an env that is gone (#1743)", () => {
  it("off still reaches a Hermes marker written under another HERMES_HOME", () => {
    const home = tmp();
    const busHome = join(home, ".oa-bus");
    const env = { HERMES_HOME: join(tmp(), "srv-hermes") };
    const dir = ours(home, env);
    setPluginHabits({ home, env, busHome }, [hermes], true);
    expect(existsSync(join(dir, HERMES_HABITS_MARKER))).toBe(true);
    const r = removeHabits({ home, busHome });
    expect(r.files).toContain(join(dir, HERMES_HABITS_MARKER));
    expect(existsSync(join(dir, HERMES_HABITS_MARKER))).toBe(false);
  });
});

describe("setPluginHabits", () => {
  it("yes writes the marker, no removes it", () => {
    const home = tmp();
    const dir = ours(home);
    expect(pluginHabitsState({ home }, hermes)).toBe("off");
    expect(setPluginHabits({ home }, [hermes], true).changed).toEqual([hermes]);
    expect(existsSync(join(dir, HERMES_HABITS_MARKER))).toBe(true);
    expect(pluginHabitsState({ home }, hermes)).toBe("on");
    expect(setPluginHabits({ home }, [hermes], false).changed).toEqual([
      hermes,
    ]);
    expect(existsSync(join(dir, HERMES_HABITS_MARKER))).toBe(false);
  });
  it.each([
    ["plain", false],
    ["symlinked", true],
  ])("no reaches a HERMES_HOME under a %s ~/.hermes", (_name, linked) => {
    const home = tmp();
    const root = linked ? join(tmp(), "hermes") : join(home, ".hermes");
    mkdirSync(root, { recursive: true });
    if (linked) symlinkSync(root, join(home, ".hermes"));
    const env = { HERMES_HOME: join(root, "custom") };
    const dir = ours(home, env);
    expect(setPluginHabits({ home, env }, [hermes], true).changed).toEqual([
      hermes,
    ]);
    expect(existsSync(join(dir, HERMES_HABITS_MARKER))).toBe(true);
    expect(setPluginHabits({ home, env }, [hermes], false).changed).toEqual([
      hermes,
    ]);
    expect(existsSync(join(dir, HERMES_HABITS_MARKER))).toBe(false);
    expect(pluginHabitsState({ home, env }, hermes)).toBe("off");
  });
  it("removeHabits (--no-habits, uninstall) takes the marker too", () => {
    const home = tmp();
    const dir = ours(home);
    setPluginHabits({ home }, [hermes], true);
    const r = removeHabits({ home });
    expect(r.files).toEqual([join(dir, HERMES_HABITS_MARKER)]);
    expect(existsSync(join(dir, HERMES_HABITS_MARKER))).toBe(false);
  });
  it("off sweeps the root and every profile, and notes a symlinked one", () => {
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
  it("refuses a folder that is not ours", () => {
    const home = tmp();
    const dir = hermesPluginDir(home, {});
    mkdirSync(dir, { recursive: true });
    const r = setPluginHabits({ home }, [hermes], true);
    expect(r.changed).toEqual([]);
    expect(r.notes[0]).toContain("wasn't installed by npx @open-artifacts/bus");
    expect(existsSync(join(dir, HERMES_HABITS_MARKER))).toBe(false);
    expect(pluginHabitsState({ home }, hermes)).toBe("not installed");
  });
  it("says so when nothing is installed", () => {
    const home = tmp();
    const r = setPluginHabits({ home }, [hermes], true);
    expect(r.notes[0]).toBe(
      `Left the Hermes plugin alone: nothing installed at ${hermesPluginDir(home, {})}.`,
    );
  });
  it("refuses a symlinked plugin folder and writes nothing through it", () => {
    const home = tmp();
    const real = join(home, "elsewhere");
    mkdirSync(real);
    writeFileSync(
      join(real, HERMES_MARKER),
      "managed by the Open Artifacts bus installer: x\n",
    );
    const dir = hermesPluginDir(home, {});
    mkdirSync(join(dir, ".."), { recursive: true });
    symlinkSync(real, dir);
    const r = setPluginHabits({ home }, [hermes], true);
    expect(r.notes[0]).toContain("symlink");
    expect(existsSync(join(real, HERMES_HABITS_MARKER))).toBe(false);
  });
  it("refuses a symlinked marker, and off unlinks it without following", () => {
    const home = tmp();
    const dir = ours(home);
    const target = join(home, "target");
    writeFileSync(target, "keep");
    symlinkSync(target, join(dir, HERMES_HABITS_MARKER));
    const r = setPluginHabits({ home }, [hermes], true);
    expect(r.changed).toEqual([]);
    expect(r.notes[0]).toContain("symlink");
    expect(readFileSync(target, "utf8")).toBe("keep");
    setPluginHabits({ home }, [hermes], false);
    expect(readFileSync(target, "utf8")).toBe("keep");
    expect(() => lstatSync(join(dir, HERMES_HABITS_MARKER))).toThrow();
  });
  it("the marker does not make the plugin stale or foreign", () => {
    const home = tmp();
    const dir = ours(home);
    const shipped = tmp();
    writeFileSync(join(shipped, "bus.py"), "X = 1\n");
    writeFileSync(
      join(dir, HERMES_MARKER),
      `managed by the Open Artifacts bus installer: edits are replaced on reinstall. ${pluginHash(shipped)}\n`,
    );
    expect(pluginState(dir, shipped)).toBe("current");
    setPluginHabits({ home }, [hermes], true);
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
const setup = (over = {}, tty = false) => {
  const ctx = fakeCtx(hermesOnly(over), tty);
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
  it("no yes, no marker; the question names the Hermes plugin", async () => {
    const ctx = setup();
    await install({ hub: HUB }, ctx);
    expect(existsSync(marker(ctx))).toBe(false);
    expect(ctx.out().join("\n")).toContain(
      "The bus would add 2 habits for sessions on the bus, to the Hermes plugin:",
    );
    expect(habitsLine(ctx)).toContain("Habits: not decided");
    expect(habitsLine(ctx)).toContain("Hermes plugin: off");
  });
  it("--habits writes it, a reinstall keeps it, --no-habits and uninstall remove it", async () => {
    const ctx = setup();
    await install({ hub: HUB }, ctx);
    await install({ habits: "yes" }, ctx);
    expect(existsSync(marker(ctx))).toBe(true);
    expect(ctx.out().join("\n")).toContain("Habits on in the Hermes plugin.");
    expect(habitsLine(ctx)).toBe("Habits: Hermes plugin: on");
    // Make the plugin stale so the reinstall recopies it.
    writeFileSync(
      join(hermesPluginDir(ctx.userHome, ctx.env), "bus.py"),
      "# edited\n",
    );
    await install({ hub: HUB }, ctx);
    expect(existsSync(marker(ctx))).toBe(true);
    expect(
      readFileSync(
        join(hermesPluginDir(ctx.userHome, ctx.env), "bus.py"),
        "utf8",
      ),
    ).not.toBe("# edited\n");
    await install({ habits: "no" }, ctx);
    expect(existsSync(marker(ctx))).toBe(false);
    expect(ctx.out().join("\n")).toContain("Habits off in the Hermes plugin.");
    await install({ habits: "yes" }, ctx);
    expect(existsSync(marker(ctx))).toBe(true);
    await uninstall({ purge: false }, ctx);
    expect(existsSync(hermesPluginDir(ctx.userHome, ctx.env))).toBe(false);
  });
  (process.getuid?.() === 0 ? it.skip : it)(
    "--no-habits that cannot remove the marker says so, exits 1 and never prints Habits off",
    async () => {
      const ctx = setup();
      await install({ hub: HUB }, ctx);
      await install({ habits: "yes" }, ctx);
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
  it("TTY yes in the flow writes it; no leaves it off and opts out", async () => {
    const yes = setup({ stdinIsTTY: true, readLine: vi.fn(async () => "y") });
    await install({ hub: HUB }, yes);
    expect(existsSync(marker(yes))).toBe(true);
    const no = setup({ stdinIsTTY: true, readLine: vi.fn(async () => "n") });
    await install({ hub: HUB }, no);
    expect(existsSync(marker(no))).toBe(false);
    expect(habitsLine(no)).toBe("Habits: off (you opted out)");
  });
  it("a symlinked marker is refused by --habits", async () => {
    const ctx = setup();
    await install({ hub: HUB }, ctx);
    const target = join(ctx.userHome, "t");
    writeFileSync(target, "keep");
    symlinkSync(target, marker(ctx));
    const code = await install({ habits: "yes" }, ctx);
    expect(code).toBe(1);
    expect(readFileSync(target, "utf8")).toBe("keep");
    rmSync(marker(ctx));
  });
  it("--show-habits lists each plugin's state, including not installed", async () => {
    const ctx = setup();
    await install({ habits: "show" }, ctx);
    expect(ctx.out().join("\n")).toContain("Hermes plugin: not installed");
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
    const r = setPluginHabits({ home }, [hermes], false);
    expect(existsSync(join(behind, HERMES_HABITS_MARKER))).toBe(false);
    expect(r.notes).toContain(
      `The Hermes profiles folder ${join(home, ".hermes", "profiles")} is a symlink to ${realpathSync(elsewhere)}. Its profiles were checked too.`,
    );
    expect(r.incomplete).toBe(false);
  });
  it("says nothing about a plain profiles folder", () => {
    const home = tmp();
    withMarker(profileDir(join(home, ".hermes"), "work"));
    const r = setPluginHabits({ home }, [hermes], false);
    expect(r.notes).toEqual([]);
    expect(r.incomplete).toBe(false);
  });
  it("says a dangling link has no profiles, without failing the off", () => {
    const home = tmp();
    mkdirSync(join(home, ".hermes"), { recursive: true });
    const gone = join(tmp(), "gone");
    symlinkSync(gone, join(home, ".hermes", "profiles"));
    const r = setPluginHabits({ home }, [hermes], false);
    expect(r.notes).toEqual([
      `The Hermes profiles folder ${join(home, ".hermes", "profiles")} is a symlink to ${gone}, which doesn't exist, so there were no profiles to check.`,
    ]);
    expect(r.incomplete).toBe(false);
  });
  it("says nothing when a plain profiles folder is missing", () => {
    const home = tmp();
    mkdirSync(join(home, ".hermes"), { recursive: true });
    const r = setPluginHabits({ home }, [hermes], false);
    expect(r.notes).toEqual([]);
    expect(r.incomplete).toBe(false);
  });
  it("says a profiles path that is a file is not a folder", () => {
    const home = tmp();
    mkdirSync(join(home, ".hermes"), { recursive: true });
    writeFileSync(join(home, ".hermes", "profiles"), "x");
    const r = setPluginHabits({ home }, [hermes], false);
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
    const r = setPluginHabits({ home }, [hermes], false);
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
        const r = setPluginHabits({ home }, [hermes], false);
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
    const r = setPluginHabits({ home }, [hermes], false);
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
        const r = setPluginHabits({ home }, [hermes], false);
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
