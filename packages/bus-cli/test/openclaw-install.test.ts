// The OpenClaw step: the built plugin folder is installed and enabled through
// OpenClaw's own CLI, and the habits marker follows the user's choice. Temp
// homes and a fake exec that behaves like the real CLI (checked against
// OpenClaw 2026.6.5 in a throwaway state dir); nothing real runs.
import {
  chmodSync,
  lstatSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStateDir } from "../../bus-adapter-openclaw/src/state-dir.ts";
import {
  type AdapterDeps,
  checkAdapters,
  type Exec,
  installAdapters,
  readAssets,
  uninstallAdapters,
} from "../src/steps/adapters.ts";
import {
  PLUGIN_HARNESSES,
  pluginHabitsState,
  removeHabits,
  setHabitsOptOut,
  setPluginHabits,
} from "../src/steps/habits.ts";
import {
  OPENCLAW_HABITS_MARKER,
  OPENCLAW_MARKER,
  openclawHome,
  openclawPluginDir,
  openclawPluginDirs,
  openclawPluginState,
  openclawStateDir,
} from "../src/steps/openclaw.ts";
import { skillDir } from "../src/steps/skill.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const openclaw = PLUGIN_HARNESSES.find(
  (p) => p.name === "openclaw",
) as (typeof PLUGIN_HARNESSES)[number];

/** A shipped plugin as the adapter's build leaves it. */
function shipped() {
  const d = tmp("oa-openclaw-src-");
  put(
    join(d, "openclaw.plugin.json"),
    JSON.stringify({ id: "oa-bus", name: "Open Artifacts bus" }),
  );
  put(join(d, "index.js"), "export default {};\n");
  put(join(d, "package.json"), '{"name":"oa-bus","version":"0.0.0"}\n');
  return d;
}

type Reply = { code: number; stdout?: string; stderr?: string };
function setup(
  opts: {
    present?: string[];
    replies?: Record<string, Reply>;
    env?: Record<string, string>;
    /** The install command wipes the folder, then fails. */
    wipeThenFail?: boolean;
    /** The install command swaps in a fresh copy (no marker), then fails. */
    swapThenFail?: boolean;
    /** What inspect reports; the default is a loaded plugin. */
    inspect?: (enabled: boolean) => unknown;
  } = {},
) {
  const home = tmp("oa-openclaw-home-");
  const busHome = join(home, ".oa-bus");
  const calls: string[][] = [];
  const envs: (Record<string, string> | undefined)[] = [];
  const timeouts: (number | undefined)[] = [];
  let enabled = false;
  const present = opts.present ?? ["openclaw"];
  const env = opts.env ?? {};
  const dest = openclawPluginDir(home, env);
  const src = shipped();
  const inspect =
    opts.inspect ??
    ((on: boolean) => ({
      plugin: {
        id: "oa-bus",
        rootDir: dest,
        enabled: on,
        status: on ? "loaded" : "disabled",
        toolNames: ["oabus_self", "oabus_send_message", "oabus_fetch"],
      },
      typedHooks: [{ name: "before_prompt_build" }],
    }));
  const deps: AdapterDeps = {
    home,
    busHome,
    env,
    busBin: ["/usr/local/bin/oa-bus"],
    assets: { pi: "PI", opencodePlugin: "OC", openclaw: src },
    which: (c) => present.includes(c),
    exec: (async (cmd, args, o) => {
      envs.push(o?.env);
      timeouts.push(o?.timeoutMs);
      const key = [cmd, ...args].join(" ");
      calls.push([cmd, ...args]);
      const hit = Object.entries(opts.replies ?? {}).find(([k]) =>
        key.startsWith(k),
      )?.[1];
      if (hit) return { stdout: "", stderr: "", ...hit };
      if (key.startsWith("openclaw plugins install")) {
        if (args.includes("--force"))
          rmSync(dest, { recursive: true, force: true });
        if (opts.swapThenFail) {
          rmSync(dest, { recursive: true, force: true });
          cpSync(src, dest, { recursive: true });
          return { code: 1, stdout: "", stderr: "swapped" };
        }
        if (opts.wipeThenFail) {
          rmSync(dest, { recursive: true, force: true });
          return { code: 1, stdout: "", stderr: "boom\nmore" };
        }
        // OpenClaw copies the folder's files, and enables it.
        cpSync(src, dest, { recursive: true });
        enabled = true;
      }
      if (key.startsWith("openclaw plugins enable")) enabled = true;
      if (key.startsWith("openclaw plugins uninstall")) {
        rmSync(dest, { recursive: true, force: true });
        enabled = false;
      }
      if (key.startsWith("openclaw plugins inspect"))
        return {
          code: 0,
          stdout: JSON.stringify(inspect(enabled)),
          stderr: "",
        };
      return { code: 0, stdout: "", stderr: "" };
    }) as Exec,
  };
  return { home, busHome, deps, calls, envs, timeouts, dest, src };
}

const INSTALL = (src: string, force = false) => [
  "openclaw",
  "plugins",
  "install",
  ...(force ? ["--force"] : []),
  src,
];
const ENABLE = ["openclaw", "plugins", "enable", "oa-bus"];
const INSPECT = [
  "openclaw",
  "plugins",
  "inspect",
  "oa-bus",
  "--runtime",
  "--json",
];
const UNINSTALL = ["openclaw", "plugins", "uninstall", "--force", "oa-bus"];

describe("openclawStateDir", () => {
  it.each([
    ["no env", {}],
    ["OPENCLAW_STATE_DIR", { OPENCLAW_STATE_DIR: "/opt/oc-state" }],
    ["a ~ state dir", { OPENCLAW_STATE_DIR: "~/state" }],
    ["OPENCLAW_HOME", { OPENCLAW_HOME: "/srv/oc" }],
    ["a ~ OPENCLAW_HOME", { OPENCLAW_HOME: "~/oc" }],
    ["OPENCLAW_PROFILE, which OpenClaw ignores", { OPENCLAW_PROFILE: "work" }],
  ])("matches the plugin's own resolution: %s", (_n, env) => {
    const home = tmp("oa-openclaw-parity-");
    // The adapter reads HOME; the CLI is handed the user's home explicitly.
    expect(openclawStateDir(home, env)).toBe(
      resolveStateDir({ ...env, HOME: home }, () => home),
    );
  });
  it("ignores OPENCLAW_PROFILE: only the --profile flag moves the state dir", () => {
    const home = tmp("oa-openclaw-noprofile-");
    expect(openclawStateDir(home, { OPENCLAW_PROFILE: "work" })).toBe(
      join(home, ".openclaw"),
    );
  });
  it("uses a legacy .clawdbot only when it alone exists", () => {
    const home = tmp("oa-openclaw-legacy-");
    mkdirSync(join(home, ".clawdbot"));
    expect(openclawStateDir(home, {})).toBe(join(home, ".clawdbot"));
    mkdirSync(join(home, ".openclaw"));
    expect(openclawStateDir(home, {})).toBe(join(home, ".openclaw"));
    expect(openclawHome(home, { OPENCLAW_HOME: "~" })).toBe(home);
  });
});

describe("installAdapters: openclaw", () => {
  it("is absent without an openclaw binary and touches nothing", async () => {
    const { deps, home, calls } = setup({ present: [] });
    const out = await installAdapters(deps);
    expect(out.absent).toContain("openclaw");
    expect(out.openclawRestart).toBe(false);
    expect(calls).toEqual([]);
    expect(existsSync(join(home, ".openclaw"))).toBe(false);
  });

  it("skips cleanly with a note in Nix mode", async () => {
    const { deps, calls } = setup({ env: { OPENCLAW_NIX_MODE: "1" } });
    const out = await installAdapters(deps);
    expect(out.absent).toContain("openclaw");
    expect(out.openclawNix).toBe(true);
    expect(out.openclawRestart).toBe(false);
    expect(calls).toEqual([]);
    expect(
      checkAdapters({
        home: deps.home,
        env: deps.env,
        which: deps.which,
      }).openclaw,
    ).toBe("absent");
  });

  it("installs, enables and verifies, in that order, with the state dir and a long timeout", async () => {
    const { deps, dest, calls, envs, timeouts, src, home } = setup();
    const out = await installAdapters(deps);
    expect(out.installed).toContain("openclaw");
    expect(out.openclawRestart).toBe(true);
    expect(calls).toEqual([INSTALL(src), ENABLE, INSPECT]);
    for (const e of envs)
      expect(e).toEqual({ OPENCLAW_STATE_DIR: join(home, ".openclaw") });
    for (const t of timeouts) expect(t).toBeGreaterThanOrEqual(30_000);
    expect(readdirSync(dest).sort()).toEqual(
      [
        ".oa-bus-managed",
        "index.js",
        "openclaw.plugin.json",
        "package.json",
      ].sort(),
    );
    expect(openclawPluginState(dest, src)).toBe("current");
    // Habits are the user's choice: never written by install.
    expect(existsSync(join(dest, OPENCLAW_HABITS_MARKER))).toBe(false);
    // Only the extensions folder was created: no config file of ours.
    expect(readdirSync(join(home, ".openclaw"))).toEqual(["extensions"]);
    for (const c of calls)
      expect(c.join(" ")).not.toMatch(/allowConversationAccess/);
  });

  it("honors OPENCLAW_STATE_DIR and OPENCLAW_HOME", async () => {
    const state = tmp("oa-openclaw-state-");
    const a = setup({ env: { OPENCLAW_STATE_DIR: state } });
    await installAdapters(a.deps);
    expect(a.dest).toBe(join(state, "extensions", "oa-bus"));
    expect(existsSync(join(a.dest, "index.js"))).toBe(true);
    expect(a.envs[0]).toEqual({ OPENCLAW_STATE_DIR: state });

    const oh = tmp("oa-openclaw-ohome-");
    const b = setup({ env: { OPENCLAW_HOME: oh } });
    await installAdapters(b.deps);
    expect(b.dest).toBe(join(oh, ".openclaw", "extensions", "oa-bus"));
    expect(existsSync(join(b.dest, "index.js"))).toBe(true);
  });

  it("only verifies a current install that already loads", async () => {
    const { deps, calls, src } = setup();
    await installAdapters(deps);
    calls.length = 0;
    const out = await installAdapters(deps);
    expect(out.installed).toContain("openclaw");
    expect(calls).toEqual([INSPECT]);
    expect(calls.flat()).not.toContain(src);
  });

  it("enables a current install that does not verify, then verifies again", async () => {
    const { deps, calls } = setup();
    await installAdapters(deps);
    // OpenClaw lost the enabled flag: the first inspect says disabled.
    let n = 0;
    const real = deps.exec;
    deps.exec = (async (c, a, o) => {
      if (a[1] === "inspect" && n++ === 0) {
        calls.push([c, ...a]);
        return {
          code: 0,
          stdout: JSON.stringify({
            plugin: { enabled: false, status: "disabled" },
          }),
          stderr: "",
        };
      }
      return real(c, a, o);
    }) as Exec;
    calls.length = 0;
    const out = await installAdapters(deps);
    expect(out.installed).toContain("openclaw");
    expect(calls).toEqual([INSPECT, ENABLE, INSPECT]);
  });

  it("gives inspect 30 s and install 180 s", async () => {
    const { deps, calls, timeouts } = setup();
    await installAdapters(deps);
    const t = (verb: string) => timeouts[calls.findIndex((c) => c[2] === verb)];
    expect(t("install")).toBe(180_000);
    expect(t("enable")).toBeLessThanOrEqual(60_000);
    expect(t("inspect")).toBe(30_000);
  });

  it("fails when a different copy of oa-bus is the one that loads", async () => {
    const other = tmp("oa-openclaw-dev-");
    const { deps } = setup({
      inspect: (on) => ({
        plugin: {
          rootDir: other,
          enabled: on,
          status: "loaded",
          toolNames: ["oabus_self", "oabus_send_message", "oabus_fetch"],
        },
        typedHooks: [{ name: "before_prompt_build" }],
      }),
    });
    const out = await installAdapters(deps);
    expect(out.installed).not.toContain("openclaw");
    expect(out.skipped[0]?.reason).toContain(
      `a different copy loads from ${other}`,
    );
  });

  it("accepts the same folder reached through a symlink", async () => {
    const real = tmp("oa-openclaw-realstate-");
    const link = join(tmp("oa-openclaw-linkdir-"), "state");
    symlinkSync(real, link);
    const { deps } = setup({
      env: { OPENCLAW_STATE_DIR: link },
      inspect: (on) => ({
        plugin: {
          rootDir: join(real, "extensions", "oa-bus"),
          enabled: on,
          status: "loaded",
          toolNames: ["oabus_self", "oabus_send_message", "oabus_fetch"],
        },
        typedHooks: [{ name: "before_prompt_build" }],
      }),
    });
    const out = await installAdapters(deps);
    expect(out.installed).toContain("openclaw");
  });

  it("does not carry a habits.on in the shipped folder into the install", async () => {
    const { deps, dest, src } = setup();
    put(join(src, OPENCLAW_HABITS_MARKER), "on\n");
    await installAdapters(deps);
    expect(existsSync(join(dest, OPENCLAW_HABITS_MARKER))).toBe(false);
  });

  it("deletes habits.on on every install once the user opted out, even a current one", async () => {
    const { deps, dest, busHome } = setup();
    await installAdapters(deps);
    setPluginHabits({ home: deps.home, env: deps.env }, [openclaw], true);
    setHabitsOptOut(busHome, true, "2026-11-09T00:00:00Z");
    expect(existsSync(join(dest, OPENCLAW_HABITS_MARKER))).toBe(true);
    await installAdapters(deps);
    expect(existsSync(join(dest, OPENCLAW_HABITS_MARKER))).toBe(false);
  });

  it("never wipes a fork that only shares the manifest id", async () => {
    const { deps, dest, calls } = setup();
    put(join(dest, "openclaw.plugin.json"), '{"id":"oa-bus"}');
    put(join(dest, "index.js"), "my fork\n");
    const out = await installAdapters(deps);
    expect(out.skipped[0]?.harness).toBe("openclaw");
    expect(calls).toEqual([]);
    expect(readFileSync(join(dest, "index.js"), "utf8")).toBe("my fork\n");
  });

  it("takes over a marker-less folder that is byte-identical to the shipped plugin", async () => {
    const { deps, dest, src, calls } = setup();
    cpSync(src, dest, { recursive: true });
    const out = await installAdapters(deps);
    expect(out.installed).toContain("openclaw");
    expect(calls[0]).toEqual(INSTALL(src, true));
  });

  it("reinstalls a stale folder with --force and keeps habits.on that was there", async () => {
    const { deps, dest, calls, src, busHome } = setup();
    await installAdapters(deps);
    setPluginHabits({ home: deps.home, env: deps.env }, [openclaw], true);
    put(join(src, "index.js"), "export default { v: 2 };\n");
    calls.length = 0;
    await installAdapters(deps);
    expect(calls[0]).toEqual(INSTALL(src, true));
    expect(readFileSync(join(dest, "index.js"), "utf8")).toContain("v: 2");
    expect(existsSync(join(dest, OPENCLAW_HABITS_MARKER))).toBe(true);
    expect(openclawPluginState(dest, src)).toBe("current");
    expect(busHome).toBeTruthy();
  });

  it("does not add habits.on on a reinstall when there was none", async () => {
    const { deps, dest, src } = setup();
    await installAdapters(deps);
    put(join(src, "index.js"), "export default { v: 3 };\n");
    await installAdapters(deps);
    expect(existsSync(join(dest, OPENCLAW_HABITS_MARKER))).toBe(false);
  });

  it("drops habits.on on a reinstall when the user opted out", async () => {
    const { deps, dest, src, busHome } = setup();
    await installAdapters(deps);
    setPluginHabits({ home: deps.home, env: deps.env }, [openclaw], true);
    setHabitsOptOut(busHome, true, "2026-11-09T00:00:00Z");
    put(join(src, "index.js"), "export default { v: 4 };\n");
    await installAdapters(deps);
    expect(existsSync(join(dest, OPENCLAW_HABITS_MARKER))).toBe(false);
    expect(openclawPluginState(dest, src)).toBe("current");
  });

  it("keeps habits.on when a forced install fails but leaves the folder", async () => {
    const { deps, dest, src } = setup({
      replies: {
        "openclaw plugins install --force": { code: 1, stderr: "nope" },
      },
    });
    // Seed a stale folder of ours with the marker on.
    put(join(dest, "openclaw.plugin.json"), '{"id":"oa-bus"}');
    put(
      join(dest, OPENCLAW_MARKER),
      "managed by the Open Artifacts bus installer: old\n",
    );
    put(join(dest, OPENCLAW_HABITS_MARKER), "on\n");
    const out = await installAdapters(deps);
    expect(out.skipped[0]?.reason).toMatch(/plugins install` failed \(nope\)/);
    expect(existsSync(join(dest, OPENCLAW_HABITS_MARKER))).toBe(true);
    expect(src).toBeTruthy();
  });

  it("does not resurrect habits.on after a failed install wiped the folder", async () => {
    const { deps, dest } = setup({ wipeThenFail: true });
    put(join(dest, "openclaw.plugin.json"), '{"id":"oa-bus"}');
    put(
      join(dest, OPENCLAW_MARKER),
      "managed by the Open Artifacts bus installer: old\n",
    );
    put(join(dest, OPENCLAW_HABITS_MARKER), "on\n");
    const out = await installAdapters(deps);
    expect(out.skipped[0]?.reason).toContain("boom");
    expect(existsSync(dest)).toBe(false);
  });

  it("does not put habits.on into a swapped-in folder that has no marker", async () => {
    const { deps, dest } = setup({ swapThenFail: true });
    put(join(dest, "openclaw.plugin.json"), '{"id":"oa-bus"}');
    put(
      join(dest, OPENCLAW_MARKER),
      "managed by the Open Artifacts bus installer: old\n",
    );
    put(join(dest, OPENCLAW_HABITS_MARKER), "on\n");
    const out = await installAdapters(deps);
    expect(out.skipped[0]?.reason).toContain("swapped");
    expect(existsSync(join(dest, "index.js"))).toBe(true);
    expect(existsSync(join(dest, OPENCLAW_MARKER))).toBe(false);
    // An interrupted upgrade loses the yes: the safe direction.
    expect(existsSync(join(dest, OPENCLAW_HABITS_MARKER))).toBe(false);
  });

  it("never replaces a folder that is not ours", async () => {
    const { deps, dest, calls } = setup();
    put(join(dest, "openclaw.plugin.json"), '{"id":"somebody-else"}');
    put(join(dest, "index.js"), "mine\n");
    const out = await installAdapters(deps);
    expect(out.skipped[0]?.harness).toBe("openclaw");
    expect(out.skipped[0]?.reason).toContain("is not Open Artifacts bus's");
    expect(calls).toEqual([]);
    expect(readFileSync(join(dest, "index.js"), "utf8")).toBe("mine\n");
  });

  it("refuses a symlinked plugin folder", async () => {
    const { deps, dest, calls } = setup();
    mkdirSync(join(dest, ".."), { recursive: true });
    symlinkSync(tmp("oa-openclaw-elsewhere-"), dest);
    const out = await installAdapters(deps);
    expect(out.skipped[0]?.harness).toBe("openclaw");
    expect(calls).toEqual([]);
  });

  it("reports an enable failure, with the folder left in place", async () => {
    const { deps, dest } = setup({
      replies: {
        "openclaw plugins enable": { code: 1, stderr: "config invalid" },
      },
    });
    const out = await installAdapters(deps);
    expect(out.installed).not.toContain("openclaw");
    expect(out.skipped[0]?.reason).toMatch(
      /enable oa-bus` failed \(config invalid\)/,
    );
    expect(existsSync(join(dest, OPENCLAW_MARKER))).toBe(true);
  });

  it.each([
    [
      "not enabled",
      () => ({ plugin: { enabled: false, status: "disabled", toolNames: [] } }),
      "not enabled",
    ],
    [
      "not loaded",
      () => ({ plugin: { enabled: true, status: "error", toolNames: [] } }),
      "error, not loaded",
    ],
    [
      "no tools",
      () => ({
        plugin: { enabled: true, status: "loaded", toolNames: ["oabus_self"] },
        typedHooks: [],
      }),
      "oabus_send_message",
    ],
    [
      "no hook",
      () => ({
        plugin: {
          enabled: true,
          status: "loaded",
          toolNames: ["oabus_self", "oabus_send_message", "oabus_fetch"],
        },
        typedHooks: [],
      }),
      "before_prompt_build hook is not registered",
    ],
  ])("fails the install when inspect shows %s", async (_n, inspect, text) => {
    const { deps } = setup({ inspect });
    const out = await installAdapters(deps);
    expect(out.installed).not.toContain("openclaw");
    expect(out.skipped[0]?.reason).toContain(text);
  });

  it("fails the install when inspect is not JSON", async () => {
    const { deps } = setup({
      replies: { "openclaw plugins inspect": { code: 0, stdout: "nope" } },
    });
    const out = await installAdapters(deps);
    expect(out.skipped[0]?.reason).toContain("not JSON");
  });

  it("fails clearly when the plugin was not built into this install", async () => {
    const { deps } = setup();
    deps.assets.openclaw = join(tmp("oa-openclaw-nobuild-"), "dist");
    const out = await installAdapters(deps);
    expect(out.skipped[0]?.reason).toBe(
      "the OpenClaw plugin is missing from this install",
    );
  });
});

describe("checkAdapters: openclaw", () => {
  it("is absent, missing, then configured, from files only", async () => {
    const { deps, src, home } = setup();
    const ask = (which: (c: string) => boolean) =>
      checkAdapters({
        home,
        env: deps.env,
        which,
        openclawPlugin: src,
      }).openclaw;
    expect(ask(() => false)).toBe("absent");
    expect(ask((c) => c === "openclaw")).toBe("missing");
    await installAdapters(deps);
    expect(ask((c) => c === "openclaw")).toBe("configured");
    writeFileSync(join(openclawPluginDir(home, {}), "index.js"), "edited\n");
    expect(ask((c) => c === "openclaw")).toBe("missing");
  });
});

describe("uninstallAdapters: openclaw", () => {
  it("uninstalls through openclaw, and the folder goes", async () => {
    const { deps, dest, calls } = setup();
    await installAdapters(deps);
    calls.length = 0;
    const out = await uninstallAdapters(deps);
    expect(out.removed).toContain("openclaw");
    expect(calls).toEqual([UNINSTALL]);
    expect(existsSync(dest)).toBe(false);
  });

  it("is none when nothing is installed", async () => {
    const { deps, calls } = setup();
    const out = await uninstallAdapters(deps);
    expect(out.removed).not.toContain("openclaw");
    expect(calls).toEqual([]);
  });

  it("removes the folder and notes it when there is no openclaw binary", async () => {
    const { deps, dest } = setup();
    await installAdapters(deps);
    const out = await uninstallAdapters({ ...deps, which: () => false });
    expect(out.removed).toContain("openclaw");
    expect(out.openclawNoCli).toBe(true);
    expect(existsSync(dest)).toBe(false);
  });

  it("leaves the folder when openclaw refuses", async () => {
    const { deps, dest } = setup();
    await installAdapters(deps);
    const out = await uninstallAdapters({
      ...deps,
      exec: (async () => ({ code: 1, stdout: "", stderr: "locked" })) as Exec,
    });
    expect(out.skipped[0]?.reason).toContain("locked");
    expect(existsSync(dest)).toBe(true);
  });

  it("never uninstalls a marker-less fork that shares the manifest id", async () => {
    const { deps, dest, calls } = setup();
    put(join(dest, "openclaw.plugin.json"), '{"id":"oa-bus"}');
    put(join(dest, "index.js"), "my fork\n");
    const out = await uninstallAdapters(deps);
    expect(out.skipped[0]?.harness).toBe("openclaw");
    expect(calls).toEqual([]);
    expect(readFileSync(join(dest, "index.js"), "utf8")).toBe("my fork\n");
  });

  it("never touches a folder that is not ours", async () => {
    const { deps, dest, calls } = setup();
    put(join(dest, "index.js"), "mine\n");
    const out = await uninstallAdapters(deps);
    expect(out.skipped[0]?.harness).toBe("openclaw");
    expect(calls).toEqual([]);
    expect(existsSync(join(dest, "index.js"))).toBe(true);
  });

  it("does nothing in Nix mode, with a note", async () => {
    const a = setup();
    await installAdapters(a.deps);
    const out = await uninstallAdapters({
      ...a.deps,
      env: { OPENCLAW_NIX_MODE: "1" },
    });
    expect(out.openclawNix).toBe(true);
    expect(out.removed).not.toContain("openclaw");
    expect(existsSync(a.dest)).toBe(true);
  });
});

describe("skills", () => {
  it("go to the managed skills folder of the active state dir", () => {
    expect(skillDir({ home: "/h" }, "openclaw")).toBe("/h/.openclaw/skills");
    expect(
      skillDir({ home: "/h", env: { OPENCLAW_STATE_DIR: "/s" } }, "openclaw"),
    ).toBe("/s/skills");
  });
  it("ships the harness's skill path and tool names", async () => {
    const { harnessSkills } = await import("@oa/shared/harness-skills");
    expect(harnessSkills.openclaw.skillPath).toContain(
      "/skills/open-artifacts/",
    );
    expect(harnessSkills.openclaw.busToolName?.("send_message")).toBe(
      "oabus_send_message",
    );
  });
  it("readAssets names the plugin folder", () => {
    expect(readAssets().openclaw).toMatch(/openclaw$|dist$/);
  });
});

// The habits marker: written only on a yes, removed from every folder of the
// install, whichever way the state dir was given.
describe("openclaw habits: on, then off", () => {
  const ours = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, OPENCLAW_MARKER),
      "managed by the Open Artifacts bus installer: edits are replaced on reinstall. abc\n",
    );
    writeFileSync(join(dir, "index.js"), "x\n");
    return dir;
  };
  const marker = (dir: string) => join(dir, OPENCLAW_HABITS_MARKER);

  it("yes writes the marker and no removes it, in the default state dir", () => {
    const home = tmp("oa-oc-habits-");
    const dir = ours(openclawPluginDir(home, {}));
    const deps = { home, env: {} };
    expect(pluginHabitsState(deps, openclaw)).toBe("off");
    expect(setPluginHabits(deps, [openclaw], true).changed).toEqual([openclaw]);
    expect(pluginHabitsState(deps, openclaw)).toBe("on");
    expect(setPluginHabits(deps, [openclaw], false).changed).toEqual([
      openclaw,
    ]);
    expect(existsSync(marker(dir))).toBe(false);
  });

  it.each([
    ["OPENCLAW_STATE_DIR outside the home", "outside"],
    ["OPENCLAW_STATE_DIR inside ~/.openclaw", "inside"],
    ["OPENCLAW_STATE_DIR through a symlink", "linked"],
    ["a symlinked ~/.openclaw with the real path given", "linked-home"],
    ["a --profile dir (OPENCLAW_STATE_DIR)", "profile"],
    ["OPENCLAW_HOME", "ohome"],
  ])("off reaches the active folder: %s", (_n, form) => {
    const home = tmp("oa-oc-habits-");
    let env: Record<string, string> = {};
    if (form === "outside")
      env = { OPENCLAW_STATE_DIR: join(tmp("oa-oc-out-"), "state") };
    if (form === "inside")
      env = { OPENCLAW_STATE_DIR: join(home, ".openclaw", "custom") };
    if (form === "linked") {
      const real = join(tmp("oa-oc-real-"), "state");
      mkdirSync(real, { recursive: true });
      const link = join(tmp("oa-oc-link-"), "state");
      symlinkSync(real, link);
      env = { OPENCLAW_STATE_DIR: link };
    }
    if (form === "linked-home") {
      const real = join(tmp("oa-oc-real-"), "oc");
      mkdirSync(real, { recursive: true });
      symlinkSync(real, join(home, ".openclaw"));
      env = { OPENCLAW_STATE_DIR: real };
    }
    if (form === "profile")
      env = { OPENCLAW_STATE_DIR: join(home, ".openclaw-work") };
    if (form === "ohome") env = { OPENCLAW_HOME: tmp("oa-oc-ohome-") };
    const dir = ours(openclawPluginDir(home, env));
    const deps = { home, env };
    expect(setPluginHabits(deps, [openclaw], true).changed).toEqual([openclaw]);
    expect(existsSync(marker(dir))).toBe(true);
    expect(pluginHabitsState(deps, openclaw)).toBe("on");
    expect(setPluginHabits(deps, [openclaw], false).changed).toEqual([
      openclaw,
    ]);
    expect(existsSync(marker(dir))).toBe(false);
    expect(pluginHabitsState(deps, openclaw)).toBe("off");
    // The same through the uninstall and --no-habits path.
    setPluginHabits(deps, [openclaw], true);
    removeHabits({ home, env });
    expect(existsSync(marker(dir))).toBe(false);
  });

  it("off also reaches every profile folder, with the active one outside them", () => {
    const home = tmp("oa-oc-habits-");
    const active = join(tmp("oa-oc-out-"), "state");
    const env = { OPENCLAW_STATE_DIR: active };
    const dirs = [
      ours(join(home, ".openclaw", "extensions", "oa-bus")),
      ours(join(home, ".openclaw-work", "extensions", "oa-bus")),
      ours(join(home, ".openclaw-eileen", "extensions", "oa-bus")),
      ours(openclawPluginDir(home, env)),
    ];
    for (const d of dirs) expect(openclawPluginDirs(home, env)).toContain(d);
    for (const d of dirs) writeFileSync(marker(d), "on\n");
    // Only the active folder was given a yes; a leftover elsewhere must go too.
    expect(setPluginHabits({ home, env }, [openclaw], false).changed).toEqual([
      openclaw,
    ]);
    for (const d of dirs) expect(existsSync(marker(d))).toBe(false);
  });

  it("a yes writes only the active folder", () => {
    const home = tmp("oa-oc-habits-");
    const env = { OPENCLAW_STATE_DIR: join(home, ".openclaw-work") };
    const other = ours(join(home, ".openclaw", "extensions", "oa-bus"));
    const active = ours(openclawPluginDir(home, env));
    setPluginHabits({ home, env }, [openclaw], true);
    expect(existsSync(marker(active))).toBe(true);
    expect(existsSync(marker(other))).toBe(false);
  });

  it("off reaches a folder written under an env that is gone (#1743)", () => {
    const home = tmp("oa-oc-habits-");
    const busHome = join(home, ".oa-bus");
    const env = { OPENCLAW_STATE_DIR: join(tmp("oa-oc-srv-"), "srv-oc") };
    const dir = ours(openclawPluginDir(home, env));
    expect(
      setPluginHabits({ home, env, busHome }, [openclaw], true).changed,
    ).toEqual([openclaw]);
    expect(existsSync(marker(dir))).toBe(true);
    // The next command runs without that env.
    const r = removeHabits({ home, busHome });
    expect(r.files).toContain(marker(dir));
    expect(existsSync(marker(dir))).toBe(false);
    // The list was cleared: a later run finds nothing to do.
    writeFileSync(marker(dir), "on\n");
    removeHabits({ home, busHome });
    expect(existsSync(marker(dir))).toBe(true);
  });

  it("--no-habits and uninstall paths both sweep recorded folders", () => {
    const home = tmp("oa-oc-habits-");
    const busHome = join(home, ".oa-bus");
    const env = { OPENCLAW_STATE_DIR: join(tmp("oa-oc-srv-"), "s") };
    const dir = ours(openclawPluginDir(home, env));
    setPluginHabits({ home, env, busHome }, [openclaw], true);
    setPluginHabits({ home, busHome }, [openclaw], false);
    expect(existsSync(marker(dir))).toBe(false);
  });

  it("tolerates an install record from before the list existed", () => {
    const home = tmp("oa-oc-habits-");
    const busHome = join(home, ".oa-bus");
    put(
      join(busHome, "install.json"),
      JSON.stringify({ habits: { optedOut: false, files: {} } }),
    );
    const dir = ours(openclawPluginDir(home, {}));
    writeFileSync(marker(dir), "on\n");
    removeHabits({ home, busHome });
    expect(existsSync(marker(dir))).toBe(false);
  });

  it("keeps the ownership and symlink checks for a recorded folder", () => {
    const home = tmp("oa-oc-habits-");
    const busHome = join(home, ".oa-bus");
    const foreign = join(tmp("oa-oc-f-"), "extensions", "oa-bus");
    put(join(foreign, "openclaw.plugin.json"), '{"id":"other"}');
    put(join(foreign, OPENCLAW_HABITS_MARKER), "theirs\n");
    const linked = join(tmp("oa-oc-l-"), "extensions", "oa-bus");
    const target = ours(tmp("oa-oc-lt-"));
    writeFileSync(marker(target), "on\n");
    mkdirSync(join(linked, ".."), { recursive: true });
    symlinkSync(target, linked);
    put(
      join(busHome, "install.json"),
      JSON.stringify({
        habits: { pluginDirs: { openclaw: [foreign, linked, 7, null] } },
      }),
    );
    const r = removeHabits({ home, busHome });
    expect(existsSync(marker(foreign))).toBe(true);
    expect(existsSync(marker(target))).toBe(true);
    expect(r.notes.join("\n")).toContain("is a symlink");
  });

  it("off removes habits.on from a marker-less folder with our manifest id, and only that file", () => {
    const home = tmp("oa-oc-habits-");
    const dir = openclawPluginDir(home, {});
    put(join(dir, "openclaw.plugin.json"), '{"id":"oa-bus"}');
    put(join(dir, "index.js"), "my fork\n");
    put(marker(dir), "on\n");
    const r = setPluginHabits({ home, env: {} }, [openclaw], false);
    expect(r.changed).toEqual([openclaw]);
    expect(existsSync(marker(dir))).toBe(false);
    expect(readFileSync(join(dir, "index.js"), "utf8")).toBe("my fork\n");
    // Another plugin's folder is left alone.
    const other = tmp("oa-oc-habits-");
    const od = openclawPluginDir(other, {});
    put(join(od, "openclaw.plugin.json"), '{"id":"other"}');
    put(marker(od), "theirs\n");
    expect(
      setPluginHabits({ home: other, env: {} }, [openclaw], false).changed,
    ).toEqual([]);
    expect(existsSync(marker(od))).toBe(true);
    // And a yes still needs our marker.
    expect(
      setPluginHabits({ home, env: {} }, [openclaw], true).changed,
    ).toEqual([]);
  });

  describe("an off that cannot finish", () => {
    const listed = (busHome: string) =>
      (JSON.parse(readFileSync(join(busHome, "install.json"), "utf8")).habits
        ?.pluginDirs?.openclaw ?? []) as string[];
    const seed = (busHome: string, dirs: string[]) =>
      put(
        join(busHome, "install.json"),
        JSON.stringify({ habits: { pluginDirs: { openclaw: dirs } } }),
      );
    const unlessRoot = process.getuid?.() === 0 ? it.skip : it;

    it("keeps an absent recorded folder, and drops one whose marker is verified gone", () => {
      const home = tmp("oa-oc-habits-");
      const busHome = join(home, ".oa-bus");
      const swept = ours(join(tmp("oa-oc-a-"), "extensions", "oa-bus"));
      writeFileSync(marker(swept), "on\n");
      const ghost = join(tmp("oa-oc-g-"), "gone", "extensions", "oa-bus");
      seed(busHome, [swept, ghost]);
      const r = setPluginHabits({ home, env: {}, busHome }, [openclaw], false);
      expect(r.incomplete).toBe(false);
      expect(existsSync(marker(swept))).toBe(false);
      expect(listed(busHome)).toEqual([ghost]);
    });

    unlessRoot(
      "counts a folder it cannot reach as a failure, with a note, and keeps it",
      () => {
        const home = tmp("oa-oc-habits-");
        const busHome = join(home, ".oa-bus");
        const root = tmp("oa-oc-locked-");
        const dir = ours(join(root, "state", "extensions", "oa-bus"));
        writeFileSync(marker(dir), "on\n");
        seed(busHome, [dir]);
        chmodSync(join(root, "state"), 0o000);
        try {
          const r = setPluginHabits(
            { home, env: {}, busHome },
            [openclaw],
            false,
          );
          expect(r.incomplete).toBe(true);
          expect(r.notes.join("\n")).toMatch(/Couldn't reach .*EACCES/);
          expect(listed(busHome)).toEqual([dir]);
        } finally {
          chmodSync(join(root, "state"), 0o755);
        }
        expect(existsSync(marker(dir))).toBe(true);
      },
    );

    unlessRoot(
      "counts a marker it cannot remove as a failure and keeps the folder listed",
      () => {
        const home = tmp("oa-oc-habits-");
        const busHome = join(home, ".oa-bus");
        const dir = ours(join(tmp("oa-oc-ro-"), "extensions", "oa-bus"));
        writeFileSync(marker(dir), "on\n");
        seed(busHome, [dir]);
        chmodSync(dir, 0o500);
        try {
          const r = setPluginHabits(
            { home, env: {}, busHome },
            [openclaw],
            false,
          );
          expect(r.incomplete).toBe(true);
          expect(r.notes.join("\n")).toContain("habits are still on");
          expect(listed(busHome)).toEqual([dir]);
        } finally {
          chmodSync(dir, 0o755);
        }
        expect(existsSync(marker(dir))).toBe(true);
      },
    );

    unlessRoot("counts an unreadable plugin folder as a failure and keeps it listed", () => {
      const home = tmp("oa-oc-habits-");
      const busHome = join(home, ".oa-bus");
      const dir = ours(join(tmp("oa-oc-z-"), "extensions", "oa-bus"));
      writeFileSync(marker(dir), "on\n");
      seed(busHome, [dir]);
      chmodSync(dir, 0o000);
      try {
        const r = setPluginHabits({ home, env: {}, busHome }, [openclaw], false);
        expect(r.incomplete).toBe(true);
        expect(r.notes.join("\n")).toContain(`Couldn't reach ${marker(dir)}`);
        expect(listed(busHome)).toEqual([dir]);
      } finally {
        chmodSync(dir, 0o755);
      }
      expect(existsSync(marker(dir))).toBe(true);
    });

    it("lets a symlink with nothing behind it go: no habits.on, or a dangling link", () => {
      const home = tmp("oa-oc-habits-");
      const busHome = join(home, ".oa-bus");
      const clean = ours(tmp("oa-oc-clean-"));
      const a = join(tmp("oa-oc-l1-"), "extensions", "oa-bus");
      const b = join(tmp("oa-oc-l2-"), "extensions", "oa-bus");
      for (const [l, t] of [
        [a, clean],
        [b, join(tmp("oa-oc-nowhere-"), "missing")],
      ] as const) {
        mkdirSync(join(l, ".."), { recursive: true });
        symlinkSync(t, l);
      }
      seed(busHome, [a, b]);
      const r = setPluginHabits({ home, env: {}, busHome }, [openclaw], false);
      expect(r.incomplete).toBe(false);
      expect(r.notes).toEqual([]);
      expect(listed(busHome)).toEqual([]);
    });

    it("treats a directory named habits.on as off, leaves it, and does not fail", () => {
      const home = tmp("oa-oc-habits-");
      const busHome = join(home, ".oa-bus");
      const dir = ours(join(tmp("oa-oc-d-"), "extensions", "oa-bus"));
      mkdirSync(marker(dir));
      seed(busHome, [dir]);
      const r = setPluginHabits({ home, env: {}, busHome }, [openclaw], false);
      expect(r.incomplete).toBe(false);
      expect(r.changed).toEqual([]);
      expect(lstatSync(marker(dir)).isDirectory()).toBe(true);
      expect(listed(busHome)).toEqual([]);
    });

    it("counts a symlinked folder as a failure and keeps it listed", () => {
      const home = tmp("oa-oc-habits-");
      const busHome = join(home, ".oa-bus");
      const target = ours(tmp("oa-oc-lt-"));
      writeFileSync(marker(target), "on\n");
      const link = join(tmp("oa-oc-l-"), "extensions", "oa-bus");
      mkdirSync(join(link, ".."), { recursive: true });
      symlinkSync(target, link);
      seed(busHome, [link]);
      const r = setPluginHabits({ home, env: {}, busHome }, [openclaw], false);
      expect(r.incomplete).toBe(true);
      expect(listed(busHome)).toEqual([link]);
      expect(existsSync(marker(target))).toBe(true);
    });

    it("writes no marker when the record cannot be written, and says so", () => {
      const home = tmp("oa-oc-habits-");
      const busHome = join(home, "not-a-folder");
      writeFileSync(busHome, "a file where the bus home should be\n");
      const dir = ours(openclawPluginDir(home, {}));
      const r = setPluginHabits({ home, env: {}, busHome }, [openclaw], true);
      expect(r.changed).toEqual([]);
      expect(r.notes.join("\n")).toContain("could not record");
      expect(existsSync(marker(dir))).toBe(false);
    });
  });

  it("refuses a folder that is not ours, and says so", () => {
    const home = tmp("oa-oc-habits-");
    const dir = openclawPluginDir(home, {});
    put(join(dir, "openclaw.plugin.json"), '{"id":"other"}');
    const r = setPluginHabits({ home, env: {} }, [openclaw], true);
    expect(r.changed).toEqual([]);
    expect(r.notes[0]).toContain("wasn't installed by");
    expect(existsSync(marker(dir))).toBe(false);
  });
});
