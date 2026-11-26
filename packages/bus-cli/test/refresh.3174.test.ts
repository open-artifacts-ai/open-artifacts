// #3174: after an auto-update restarts the daemon, refreshAdapters brings every
// copied harness asset up to this version without touching configs, restarting
// services, adding unwired harnesses, or prompting. Temp homes and fake exec;
// nothing touches the real home.
import { EventEmitter } from "node:events";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HERMES_PLUGIN } from "@oa/bus-adapter-hermes";
import { OPENCODE_TUI_PLUGIN } from "@oa/bus-adapter-opencode";
import { PI_EXTENSION } from "@oa/bus-adapter-pi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemon, REFRESH_EVENT } from "../src/commands/daemon.ts";
import { codexHookOutput } from "../src/commands/rules.ts";
import {
  type AdapterDeps,
  type Exec,
  installAdapters,
  paths,
  type RefreshResult,
  readAssets,
  refreshAdapters,
} from "../src/steps/adapters.ts";
import { codexHookCommand, codexHooks } from "../src/steps/codex.ts";
import { setHabitsOptOut } from "../src/steps/habits.ts";
import { hermesPluginDir, pluginState } from "../src/steps/hermes.ts";
import {
  openclawPluginDir,
  openclawPluginState,
} from "../src/steps/openclaw.ts";
import { fakeCtx, HUB, TOKEN } from "./fake.ts";

const BIN = ["/opt/node/bin/node", "/tmp/oa-bus/bin/dist/index.js"];

const tempDirs: string[] = [];

const tmp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

/** Copies a plugin folder to a temp dir and mutates one file to simulate v1. */
function makeOldHermes(): string {
  const dir = tmp("oa-refresh-hermes-v1-");
  cpSync(HERMES_PLUGIN, dir, { recursive: true });
  const py = join(dir, "plugin.py");
  writeFileSync(py, `${readFileSync(py, "utf8")}\n# v1\n`);
  return dir;
}

/**
 * Returns { oldDir, newDir } for OpenClaw. Uses the built OPENCLAW_PLUGIN when
 * present, else builds a synthetic v2/v1 pair matching openclaw-install.test.ts.
 */
function makeOpenclawPair(shippedDir: string | undefined): {
  oldDir: string;
  newDir: string;
} {
  let newDir: string;
  if (
    shippedDir !== undefined &&
    existsSync(join(shippedDir, "openclaw.plugin.json"))
  ) {
    newDir = shippedDir;
  } else {
    newDir = tmp("oa-refresh-openclaw-v2-");
    put(
      join(newDir, "openclaw.plugin.json"),
      JSON.stringify({ id: "oa-bus", name: "Open Artifacts bus" }),
    );
    put(join(newDir, "index.js"), "export default { v: 2 };\n");
    put(join(newDir, "package.json"), '{"name":"oa-bus","version":"2.0.0"}\n');
  }
  const oldDir = tmp("oa-refresh-openclaw-v1-");
  cpSync(newDir, oldDir, { recursive: true });
  const entry = join(oldDir, "index.js");
  const prev = existsSync(entry) ? readFileSync(entry, "utf8") : "";
  writeFileSync(entry, `${prev}\n// v1\n`);
  return { oldDir, newDir };
}

function makeHarnessEnv(home: string) {
  return {
    CODEX_HOME: join(home, "codex"),
    PI_CODING_AGENT_DIR: join(home, "pi-agent"),
    OPENCODE_CONFIG_DIR: join(home, "opencode"),
    HERMES_HOME: join(home, "hermes"),
    OPENCLAW_STATE_DIR: join(home, "openclaw"),
    PATH: "",
  };
}

function makeFakeExec(home: string, env: Record<string, string>) {
  const calls: string[][] = [];
  let hermesEnabled = false;
  let openclawEnabled = false;
  const ocDest = openclawPluginDir(home, env);
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = [cmd, ...args].join(" ");
    if (key === "opencode --version")
      return { code: 0, stdout: "opencode v2.0.32\n", stderr: "" };
    if (key.startsWith("hermes plugins enable")) {
      hermesEnabled = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (key.startsWith("hermes plugins list"))
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            name: "oa-bus",
            status: hermesEnabled ? "enabled" : "not enabled",
          },
        ]),
        stderr: "",
      };
    if (key.startsWith("openclaw plugins install")) {
      const src = args.at(-1) as string;
      if (args.includes("--force"))
        rmSync(ocDest, { recursive: true, force: true });
      cpSync(src, ocDest, { recursive: true });
      openclawEnabled = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (key.startsWith("openclaw plugins enable")) {
      openclawEnabled = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (key.startsWith("openclaw plugins inspect"))
      return {
        code: 0,
        stdout: JSON.stringify({
          plugin: {
            id: "oa-bus",
            rootDir: ocDest,
            enabled: openclawEnabled,
            status: openclawEnabled ? "loaded" : "disabled",
            toolNames: ["oabus_self", "oabus_send_message", "oabus_fetch"],
          },
          typedHooks: [{ name: "before_prompt_build" }],
        }),
        stderr: "",
      };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, exec };
}

describe("refreshAdapters (#3174)", () => {
  it("updates every wired harness after a simulated auto-update, then is idempotent", async () => {
    const home = tmp("oa-refresh-home-");
    const busHome = join(home, "bus");
    const env = makeHarnessEnv(home);
    mkdirSync(env.CODEX_HOME, { recursive: true });

    const shipped = readAssets();
    const oldHermes = makeOldHermes();
    const ocPair = makeOpenclawPair(shipped.openclaw);
    const fake = makeFakeExec(home, env);
    const present = ["opencode", "pi", "codex", "hermes", "openclaw"];

    const oldDeps: AdapterDeps = {
      home,
      busHome,
      env,
      busBin: BIN,
      assets: {
        pi: "// pi extension v1\n",
        opencodePlugin: "// tui v1\n",
        hermes: oldHermes,
        openclaw: ocPair.oldDir,
      },
      which: (c) => present.includes(c),
      exec: fake.exec,
      isolated: true,
    };

    const installed = await installAdapters(oldDeps);
    expect(installed.skipped).toEqual([]);
    expect(installed.installed).toEqual(
      expect.arrayContaining(["opencode", "pi", "codex", "hermes", "openclaw"]),
    );

    // Previous release wrote no Codex hook.
    const hooksPath = codexHooks(home, env);
    rmSync(hooksPath, { force: true });
    expect(existsSync(hooksPath)).toBe(false);

    const p = paths(oldDeps);
    const ocConfigPath = join(env.OPENCODE_CONFIG_DIR, "opencode.json");
    const ocConfigBefore = readFileSync(ocConfigPath, "utf8");
    const ocCliBefore = readFileSync(p.opencodeCli, "utf8");
    const codexConfigBefore = readFileSync(p.codex, "utf8");

    fake.calls.length = 0;

    // Auto-update: new daemon runs refreshAdapters with shipped assets.
    const newAssets = { ...shipped, openclaw: ocPair.newDir };
    const newDeps: AdapterDeps = { ...oldDeps, assets: newAssets };
    const res = await refreshAdapters(newDeps);

    expect(res.skipped).toEqual([]);
    expect(res.refreshed).toEqual(
      expect.arrayContaining(["opencode", "pi", "codex", "hermes", "openclaw"]),
    );

    // No OpenCode service restart and no harness config edits.
    expect(
      fake.calls.some(
        (c) => c[0] === "opencode" && c[1] === "service" && c[2] === "restart",
      ),
    ).toBe(false);
    expect(readFileSync(ocConfigPath, "utf8")).toBe(ocConfigBefore);
    expect(readFileSync(p.opencodeCli, "utf8")).toBe(ocCliBefore);
    expect(readFileSync(p.codex, "utf8")).toBe(codexConfigBefore);

    const homePrefix = `process.env.OA_BUS_HOME ||= ${JSON.stringify(resolve(busHome))};\n`;

    // Pi extension equals shipped PI_EXTENSION with home line first.
    expect(readFileSync(p.pi, "utf8")).toBe(
      `${homePrefix}${readFileSync(PI_EXTENSION, "utf8")}`,
    );

    // OpenCode TUI plugin equals shipped OPENCODE_TUI_PLUGIN with home line first.
    const tuiPath = join(p.opencodePlugin, "tui.js");
    expect(readFileSync(tuiPath, "utf8")).toBe(
      `${homePrefix}${readFileSync(OPENCODE_TUI_PLUGIN, "utf8")}`,
    );

    // opencode.json's oa_bus entry still runs [...busBin, "mcp", "opencode"].
    const ocDoc = JSON.parse(readFileSync(ocConfigPath, "utf8")) as {
      mcp: { servers: { oa_bus: { command: string[] } } };
    };
    expect(ocDoc.mcp.servers.oa_bus.command).toEqual([
      ...BIN,
      "mcp",
      "opencode",
    ]);

    // Codex hooks.json has one SessionStart group with the expected command.
    const hooksDoc = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      hooks: {
        SessionStart: { hooks: { type: string; command: string }[] }[];
      };
    };
    expect(hooksDoc.hooks.SessionStart).toHaveLength(1);
    expect(hooksDoc.hooks.SessionStart[0]?.hooks).toHaveLength(1);
    expect(hooksDoc.hooks.SessionStart[0]?.hooks[0]?.command).toBe(
      codexHookCommand(BIN, home, busHome),
    );
    // Shipped assets' rule delivery is tested per harness in bus-adapter-pi/opencode/hermes/openclaw rules tests.
    const hookPayload = JSON.parse(
      await codexHookOutput(async () => "RULES"),
    ) as { hookSpecificOutput: { additionalContext: string } };
    expect(hookPayload.hookSpecificOutput.additionalContext).toBe("RULES");

    // Hermes and OpenClaw plugin folders are now current.
    expect(pluginState(hermesPluginDir(home, env), newAssets.hermes)).toBe(
      "current",
    );
    expect(
      openclawPluginState(openclawPluginDir(home, env), newAssets.openclaw),
    ).toBe("current");

    // Second refresh is a no-op: refreshed is [] and no file bytes change.
    const piBytes = readFileSync(p.pi, "utf8");
    const tuiBytes = readFileSync(tuiPath, "utf8");
    const hooksBytes = readFileSync(hooksPath, "utf8");
    const hermesPy = readFileSync(
      join(hermesPluginDir(home, env), "plugin.py"),
      "utf8",
    );
    const ocIndex = readFileSync(
      join(openclawPluginDir(home, env), "index.js"),
      "utf8",
    );

    const again = await refreshAdapters(newDeps);
    expect(again).toEqual({ refreshed: [], skipped: [] });
    expect(readFileSync(p.pi, "utf8")).toBe(piBytes);
    expect(readFileSync(tuiPath, "utf8")).toBe(tuiBytes);
    expect(readFileSync(hooksPath, "utf8")).toBe(hooksBytes);
    expect(
      readFileSync(join(hermesPluginDir(home, env), "plugin.py"), "utf8"),
    ).toBe(hermesPy);
    expect(
      readFileSync(join(openclawPluginDir(home, env), "index.js"), "utf8"),
    ).toBe(ocIndex);
  });

  it("does nothing and creates no files on a home with no wired harnesses", async () => {
    const home = tmp("oa-refresh-empty-");
    const busHome = join(home, "bus");
    const env = makeHarnessEnv(home);
    const shipped = readAssets();
    const fake = makeFakeExec(home, env);
    const deps: AdapterDeps = {
      home,
      busHome,
      env,
      busBin: BIN,
      assets: shipped,
      which: () => true,
      exec: fake.exec,
      isolated: true,
    };

    const res = await refreshAdapters(deps);
    expect(res).toEqual({ refreshed: [], skipped: [] });
    expect(readdirSync(home)).toEqual([]);
    expect(existsSync(codexHooks(home, env))).toBe(false);
    expect(existsSync(paths(deps).pi)).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it("leaves another bus home's Pi extension byte-identical", async () => {
    const home = tmp("oa-refresh-other-");
    const busHome = join(home, "bus-a");
    const otherBusHome = join(home, "bus-b");
    const env = makeHarnessEnv(home);
    const deps: AdapterDeps = {
      home,
      busHome,
      env,
      busBin: BIN,
      assets: readAssets(),
      which: () => false,
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      isolated: true,
    };

    const otherPi = `process.env.OA_BUS_HOME ||= ${JSON.stringify(resolve(otherBusHome))};\n// other bus pi v1\n`;
    const piPath = paths(deps).pi;
    put(piPath, otherPi);

    const res = await refreshAdapters(deps);
    expect(res).toEqual({ refreshed: [], skipped: [] });
    expect(readFileSync(piPath, "utf8")).toBe(otherPi);
  });

  it("removes an earlier Codex hook when habits are opted out", async () => {
    const home = tmp("oa-refresh-optout-");
    const busHome = join(home, "bus");
    const env = makeHarnessEnv(home);
    mkdirSync(env.CODEX_HOME, { recursive: true });
    const deps: AdapterDeps = {
      home,
      busHome,
      env,
      busBin: BIN,
      assets: readAssets(),
      which: (c) => c === "codex",
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      isolated: true,
    };

    await installAdapters(deps);
    const hooksPath = codexHooks(home, env);
    expect(existsSync(hooksPath)).toBe(true);
    expect(readFileSync(hooksPath, "utf8")).toContain("rules codex-hook");

    setHabitsOptOut(busHome, true, new Date().toISOString());

    const res = await refreshAdapters(deps);
    expect(res.skipped).toEqual([]);
    expect(res.refreshed).toContain("codex");
    expect(existsSync(hooksPath)).toBe(false);
  });
});

describe("daemon() calls refreshAdapters after startup (#3174)", () => {
  it("calls refresh once after run resolves with ctx.home and shipped assets", async () => {
    const userHome = tmp("oa-daemon-refresh-");
    const ctx = fakeCtx({
      userHome,
      home: join(userHome, ".oa-bus"),
      env: {},
      service: {
        ensure: async () => ({}),
        remove: async () => ({}),
        cli: () => BIN,
        argv: () => BIN,
      },
    });
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(
      join(ctx.home, "machine.json"),
      JSON.stringify({
        hub: HUB,
        machine_id: "m",
        label: "l",
        machine_token: TOKEN,
      }),
    );

    let resolveRun!: (d: { stop: () => Promise<void> }) => void;
    const run = vi.fn(
      () =>
        new Promise<{ stop: () => Promise<void> }>((r) => {
          resolveRun = r;
        }),
    );
    const refresh = vi.fn(
      async (_deps: AdapterDeps): Promise<RefreshResult> => ({
        refreshed: ["pi"],
        skipped: [],
      }),
    );
    const signals = new EventEmitter() as never;

    const done = daemon(ctx, run as never, signals, refresh);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    // Not called before the daemon is up.
    expect(refresh).not.toHaveBeenCalled();

    resolveRun({ stop: async () => {} });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    const callDeps = refresh.mock.calls[0]?.[0];
    expect(callDeps?.busHome).toBe(ctx.home);
    expect(callDeps?.home).toBe(ctx.userHome);
    expect(callDeps?.busBin).toEqual(BIN);
    expect(callDeps?.assets).toEqual(readAssets());

    const logFile = join(ctx.home, "logs/events.log");
    await vi.waitFor(() =>
      expect(readFileSync(logFile, "utf8")).toContain(
        `${REFRESH_EVENT} name=pi`,
      ),
    );

    (signals as unknown as EventEmitter).emit("SIGTERM");
    expect(await done).toBe(0);
  });

  it("does not call refresh for an unwired bus home", async () => {
    const userHome = tmp("oa-daemon-unwired-");
    const otherHome = join(userHome, "other-bus");
    const ctx = fakeCtx({
      userHome,
      home: otherHome,
      env: {},
      service: {
        ensure: async () => ({}),
        remove: async () => ({}),
        cli: () => BIN,
        argv: () => BIN,
      },
    });
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(
      join(ctx.home, "machine.json"),
      JSON.stringify({
        hub: HUB,
        machine_id: "m",
        label: "l",
        machine_token: TOKEN,
      }),
    );

    const run = vi.fn(async () => ({ stop: async () => {} }) as never);
    const refresh = vi.fn(
      async (): Promise<RefreshResult> => ({ refreshed: [], skipped: [] }),
    );
    const signals = new EventEmitter() as never;

    const done = daemon(ctx, run as never, signals, refresh);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    // Wait for run() to settle and its .then(...) branch to run before SIGTERM.
    await run.mock.results[0]?.value;
    await new Promise<void>((r) => setImmediate(r));
    (signals as unknown as EventEmitter).emit("SIGTERM");
    expect(await done).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
  });
});
