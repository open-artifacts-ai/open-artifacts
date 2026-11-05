import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processArgs, realCtx } from "../src/context.ts";
import { guardServiceManager, makeExec, resolveCmd } from "../src/deps.ts";
import {
  type CliSource,
  installCli,
  isDefaultHome,
  isOurDaemon,
  LAUNCHD_LABEL,
  REVOKED_EXIT,
  renderPlist,
  renderSystemd,
  type ServiceDeps,
  SYSTEMD_UNIT,
  serviceNames,
  systemService,
  type Unit,
} from "../src/steps/service.ts";
import { SENTINEL_HOME, serviceWrites } from "./sentinel.ts";

const unit = (over: Partial<Unit> = {}): Unit => ({
  node: "/usr/local/bin/node",
  entry: "/Users/leo/.oa-bus/bin/oa-bus.js",
  env: { PATH: "/usr/bin:/bin" },
  out: "/Users/leo/.oa-bus/logs/daemon.log",
  err: "/Users/leo/.oa-bus/logs/daemon.err.log",
  ...over,
});

describe("renderPlist", () => {
  it("runs node on the stable copy, keeps it alive on failure, logs under logs/", () => {
    const p = renderPlist(unit());
    expect(p).toContain(`<key>Label</key><string>${LAUNCHD_LABEL}</string>`);
    expect(p).toContain(
      "<array><string>/usr/local/bin/node</string><string>/Users/leo/.oa-bus/bin/oa-bus.js</string><string>daemon</string></array>",
    );
    expect(p).toContain(
      "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    );
    expect(p).toContain(
      "<key>StandardOutPath</key><string>/Users/leo/.oa-bus/logs/daemon.log</string>",
    );
    expect(p).toContain(
      "<key>StandardErrorPath</key><string>/Users/leo/.oa-bus/logs/daemon.err.log</string>",
    );
    expect(p).toContain("<key>PATH</key><string>/usr/bin:/bin</string>");
    expect(p).not.toContain("OA_BUS_HOME");
  });

  it("escapes XML and keeps spaces", () => {
    const p = renderPlist(
      unit({
        entry: "/Users/a b/<x>&'\".js",
        env: { PATH: "/a&b", OA_BUS_HOME: "/Users/a b/bus" },
      }),
    );
    expect(p).toContain(
      "<string>/Users/a b/&lt;x&gt;&amp;&apos;&quot;.js</string>",
    );
    expect(p).toContain("<key>PATH</key><string>/a&amp;b</string>");
    expect(p).toContain(
      "<key>OA_BUS_HOME</key><string>/Users/a b/bus</string>",
    );
  });

  it("refuses a value with a line break", () => {
    expect(() => renderPlist(unit({ entry: "/a\n/b" }))).toThrow(/line break/);
    expect(() => renderPlist(unit({ env: { PATH: "/a\r" } }))).toThrow(
      /line break/,
    );
  });
});

describe("renderSystemd", () => {
  it("quotes ExecStart, restarts on failure but not on revoke", () => {
    const u = renderSystemd(unit());
    expect(u).toContain(
      'ExecStart="/usr/local/bin/node" "/Users/leo/.oa-bus/bin/oa-bus.js" daemon',
    );
    expect(u).toContain("Restart=on-failure");
    expect(u).toContain(`RestartPreventExitStatus=${REVOKED_EXIT}`);
    expect(u).toContain('Environment="PATH=/usr/bin:/bin"');
    expect(u).toContain(
      "StandardOutput=append:/Users/leo/.oa-bus/logs/daemon.log",
    );
    expect(u).toContain(
      "StandardError=append:/Users/leo/.oa-bus/logs/daemon.err.log",
    );
    expect(u).toContain("WantedBy=default.target");
  });

  it("escapes quotes, backslashes, specifiers and variables; keeps spaces", () => {
    const u = renderSystemd(
      unit({
        entry: '/home/a b/x"\\%$y.js',
        env: { PATH: "/a b:%h", OA_BUS_HOME: "/home/a b/bus" },
        out: "/home/a b/50%.log",
      }),
    );
    expect(u).toContain('"/home/a b/x\\"\\\\%%$$y.js" daemon');
    expect(u).toContain('Environment="PATH=/a b:%%h"');
    expect(u).toContain('Environment="OA_BUS_HOME=/home/a b/bus"');
    expect(u).toContain("StandardOutput=append:/home/a b/50%%.log");
  });

  it("refuses a value with a line break", () => {
    expect(() => renderSystemd(unit({ node: "/n\node" }))).toThrow(
      /line break/,
    );
    expect(() =>
      renderSystemd(unit({ env: { PATH: "/a\n[Service]" } })),
    ).toThrow(/line break/);
  });
});

const tmp = () => mkdtempSync(join(tmpdir(), "ob-svc-"));

describe("installCli", () => {
  it("copies the package's dist, assets and manifest into <home>/bin", () => {
    const pkg = tmp();
    const file = join(pkg, "dist/index.js");
    mkdirSync(join(pkg, "dist"));
    writeFileSync(file, "// bundle");
    mkdirSync(join(pkg, "assets"));
    writeFileSync(join(pkg, "assets/plugin.ts"), "x");
    writeFileSync(join(pkg, "package.json"), '{ "name": "oa-bus" }');
    mkdirSync(join(pkg, "node_modules"));
    const home = join(tmp(), ".oa-bus");
    const entry = installCli(home, { kind: "bundle", file });
    expect(entry).toBe(join(home, "bin/dist/index.js"));
    expect(readFileSync(entry, "utf8")).toBe("// bundle");
    expect(readFileSync(join(home, "bin/assets/plugin.ts"), "utf8")).toBe("x");
    expect(readFileSync(join(home, "bin/package.json"), "utf8")).toContain(
      "oa-bus",
    );
    expect(existsSync(join(home, "bin/node_modules"))).toBe(false);
    // A second install replaces the copy, not nests it.
    writeFileSync(file, "// v2");
    installCli(home, { kind: "bundle", file });
    expect(readFileSync(entry, "utf8")).toBe("// v2");
    expect(existsSync(join(home, "bin/bin"))).toBe(false);
  });

  it("before the bundle, writes a shim that runs these sources", () => {
    const home = join(tmp(), ".oa-bus");
    const src: CliSource = {
      kind: "dev",
      main: new URL("../src/main.ts", import.meta.url).pathname,
      jiti: import.meta.resolve("jiti"),
    };
    const entry = installCli(home, src);
    expect(entry).toBe(join(home, "bin/oa-bus.js"));
    const out = execFileSync(process.execPath, [entry, "version"], {
      env: { ...process.env, OA_BUS_HOME: home, NO_COLOR: "1" },
      encoding: "utf8",
    });
    expect(out).toMatch(/^oa-bus \d+\.\d+\.\d+/);
    // Measures jiti's cold transpile on a loaded runner, not the shim (#1478).
  }, 30_000);
});

type Call = [string, string[]];

function deps(
  platform: NodeJS.Platform,
  over: Partial<ServiceDeps> = {},
  fail: (cmd: string, args: string[]) => boolean = () => false,
) {
  const userHome = tmp();
  const home = join(userHome, ".oa-bus");
  const calls: Call[] = [];
  const pkg = tmp();
  mkdirSync(join(pkg, "dist"));
  writeFileSync(join(pkg, "dist/index.js"), "// bundle");
  const d: ServiceDeps = {
    platform,
    userHome,
    home: () => home,
    env: { PATH: "/opt/x/bin:/usr/bin" },
    exec: vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return fail(cmd, args)
        ? { code: 1, stdout: "", stderr: "Failed to connect to bus" }
        : { code: 0, stdout: "", stderr: "" };
    }),
    sleep: vi.fn(async () => {}),
    execPath: "/opt/node/bin/node",
    uid: 501,
    user: "leo",
    lingerDir: join(userHome, "linger"),
    source: () => ({ kind: "bundle", file: join(pkg, "dist/index.js") }),
    daemonPid: vi.fn(async (): Promise<number | undefined> => undefined),
    // A terminal run of ours, unless a test says otherwise.
    processArgs: () => "node /usr/local/bin/oa-bus daemon",
    kill: vi.fn(),
    spawnDaemon: vi.fn(),
    ...over,
  };
  return { d, calls, userHome, home };
}

describe("serviceNames: a home that does not exist yet", () => {
  it("is stable across creating it under a symlinked parent", () => {
    const target = mkdtempSync(join(tmpdir(), "ob-real-"));
    const link = `${target}-link`;
    symlinkSync(target, link);
    const userHome = join(target, "user");
    const home = join(link, "nope", "home");
    const before = serviceNames(home, userHome);
    mkdirSync(join(target, "nope", "home"), { recursive: true });
    expect(serviceNames(home, userHome)).toEqual(before);
    rmSync(link);
    rmSync(target, { recursive: true, force: true });
  });

  it("isDefaultHome agrees via a symlinked userHome before .oa-bus exists", () => {
    const target = mkdtempSync(join(tmpdir(), "ob-real-"));
    const link = `${target}-link`;
    symlinkSync(target, link);
    expect(isDefaultHome(join(target, ".oa-bus"), link)).toBe(true);
    expect(isDefaultHome(join(link, ".oa-bus"), target)).toBe(true);
    rmSync(link);
    rmSync(target, { recursive: true, force: true });
  });
});

describe("systemService: launchd", () => {
  const plistOf = (userHome: string) =>
    join(userHome, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`);

  it("copies the cli, writes the plist and bootstraps it", async () => {
    const { d, calls, userHome, home } = deps("darwin");
    const s = systemService(d);
    expect(s.kind).toBeUndefined();
    await s.ensure();
    const plist = readFileSync(plistOf(userHome), "utf8");
    expect(plist).toContain(
      `<string>/opt/node/bin/node</string><string>${home}/bin/dist/index.js</string><string>daemon</string>`,
    );
    expect(plist).toContain(
      "<key>PATH</key><string>/opt/x/bin:/usr/bin</string>",
    );
    expect(plist).not.toContain("OA_BUS_HOME");
    expect(plist).toContain(`${home}/logs/daemon.log`);
    expect(existsSync(join(home, "bin/dist/index.js"))).toBe(true);
    expect(existsSync(join(home, "logs"))).toBe(true);
    expect(calls).toEqual([
      ["launchctl", ["bootout", `gui/501/${LAUNCHD_LABEL}`]],
      ["launchctl", ["bootstrap", "gui/501", plistOf(userHome)]],
    ]);
    expect(s.kind).toBe("launchd");
    expect(d.spawnDaemon).not.toHaveBeenCalled();
  });

  it("passes OA_BUS_HOME when it is not the default", async () => {
    const { d, userHome } = deps("darwin");
    const other = join(userHome, "elsewhere bus");
    await systemService({ ...d, home: () => other }).ensure();
    const { label } = serviceNames(other, userHome);
    expect(label).toMatch(/^com\.open-artifacts\.bus\.[0-9a-f]{8}$/);
    const plist = readFileSync(
      join(userHome, "Library/LaunchAgents", `${label}.plist`),
      "utf8",
    );
    expect(plist).toContain(`<key>OA_BUS_HOME</key><string>${other}</string>`);
    expect(plist).toContain(`<key>Label</key><string>${label}</string>`);
  });

  it("argv: the CLI the entries run, recorded by cli(), even after --no-service (C26e)", async () => {
    const { d, userHome } = deps("darwin");
    const s = systemService(d);
    const entry = join(userHome, ".oa-bus/bin/dist/index.js");
    // Before any install: what install would write now.
    expect(s.argv?.()).toEqual(["/opt/node/bin/node", entry]);
    await s.ensure();
    s.cli();
    // A later install --no-service under another node: no ensure, so the
    // service record keeps the old node, but the entries get the new one.
    const now = systemService({ ...d, execPath: "/new/node" });
    now.cli();
    expect(now.argv?.()).toEqual(["/new/node", entry]);
    // doctor under yet another node still names what the entries run.
    expect(systemService({ ...d, execPath: "/other/node" }).argv?.()).toEqual([
      "/new/node",
      entry,
    ]);
  });

  it("passes CODEX_HOME when it is not the default, and records the env (C26e)", async () => {
    const { d, userHome } = deps("darwin");
    const codex = join(userHome, "work codex");
    const s = systemService({ ...d, env: { ...d.env, CODEX_HOME: codex } });
    await s.ensure();
    expect(readFileSync(plistOf(userHome), "utf8")).toContain(
      `<key>CODEX_HOME</key><string>${codex}</string>`,
    );
    expect(s.env?.()).toEqual({
      PATH: "/opt/x/bin:/usr/bin",
      CODEX_HOME: codex,
    });
    // The default Codex home is not passed.
    const t = systemService({
      ...d,
      env: { ...d.env, CODEX_HOME: join(userHome, ".codex") },
    });
    await t.ensure();
    expect(readFileSync(plistOf(userHome), "utf8")).not.toContain("CODEX_HOME");
    expect(t.env?.()).toEqual({ PATH: "/opt/x/bin:/usr/bin" });
  });

  it("boots out and writes the same label under a symlinked, missing home", async () => {
    const { d, calls, userHome } = deps("darwin");
    const target = mkdtempSync(join(tmpdir(), "ob-real-"));
    const link = `${target}-link`;
    symlinkSync(target, link);
    const other = join(link, "missing", "home");
    const before = serviceNames(other, userHome).label;
    await systemService({ ...d, home: () => other }).ensure();
    expect(serviceNames(other, userHome).label).toBe(before);
    expect(calls[0]).toEqual(["launchctl", ["bootout", `gui/501/${before}`]]);
    expect(
      existsSync(join(userHome, "Library/LaunchAgents", `${before}.plist`)),
    ).toBe(true);
    rmSync(link);
    rmSync(target, { recursive: true, force: true });
  });

  it("retries a bootstrap that races the bootout once", async () => {
    let n = 0;
    const { d, calls } = deps(
      "darwin",
      {},
      (_c, a) => a[0] === "bootstrap" && n++ === 0,
    );
    const s = systemService(d);
    await s.ensure();
    expect(calls.filter((c) => c[1][0] === "bootstrap")).toHaveLength(2);
    expect(s.kind).toBe("launchd");
  });

  it("remove stops the service and deletes the plist; false when there was none", async () => {
    const { d, calls, userHome } = deps("darwin");
    const s = systemService(d);
    expect(await s.remove()).toEqual({});
    await s.ensure();
    calls.length = 0;
    expect(await s.remove()).toEqual({ unit: "launchd" });
    expect(calls).toEqual([
      ["launchctl", ["bootout", `gui/501/${LAUNCHD_LABEL}`]],
    ]);
    expect(existsSync(plistOf(userHome))).toBe(false);
    expect(s.kind).toBeUndefined();
  });

  it("remove waits until the daemon stops answering", async () => {
    let answers = 0;
    const { d } = deps("darwin", {
      daemonPid: vi.fn(async () => (answers-- > 0 ? 7 : undefined)),
    });
    const s = systemService(d);
    await s.ensure();
    answers = 3;
    vi.mocked(d.daemonPid).mockClear();
    await s.remove();
    expect(d.daemonPid).toHaveBeenCalledTimes(4);
    // The service manager stopped it; remove never signals a unit's daemon.
    expect(d.kill).not.toHaveBeenCalled();
  });
});

describe("systemService: systemd", () => {
  const unitOf = (userHome: string) =>
    join(userHome, ".config/systemd/user", SYSTEMD_UNIT);

  it("writes the unit, reloads, enables and restarts it", async () => {
    const { d, calls, userHome, home } = deps("linux");
    const s = systemService(d);
    await s.ensure();
    const u = readFileSync(unitOf(userHome), "utf8");
    expect(u).toContain(
      `ExecStart="/opt/node/bin/node" "${home}/bin/dist/index.js" daemon`,
    );
    expect(u).toContain('Environment="PATH=/opt/x/bin:/usr/bin"');
    expect(calls).toEqual([
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "enable", SYSTEMD_UNIT]],
      ["systemctl", ["--user", "restart", SYSTEMD_UNIT]],
    ]);
    expect(s.kind).toBe("systemd");
  });

  it("honours XDG_CONFIG_HOME", async () => {
    const { d, userHome } = deps("linux");
    const xdg = join(userHome, "xdg");
    await systemService({
      ...d,
      env: { ...d.env, XDG_CONFIG_HOME: xdg },
    }).ensure();
    expect(existsSync(join(xdg, "systemd/user", SYSTEMD_UNIT))).toBe(true);
  });

  it("falls back to a background daemon when systemctl --user fails", async () => {
    const { d, userHome, home } = deps("linux", {}, (c) => c === "systemctl");
    const s = systemService(d);
    await s.ensure();
    expect(existsSync(unitOf(userHome))).toBe(false);
    expect(s.kind).toBeUndefined();
    expect(d.spawnDaemon).toHaveBeenCalledWith(
      "/opt/node/bin/node",
      [join(home, "bin/dist/index.js"), "daemon"],
      {
        env: { PATH: "/opt/x/bin:/usr/bin" },
        out: join(home, "logs/daemon.log"),
        err: join(home, "logs/daemon.log"),
      },
    );
  });

  it("the fallback never starts a second daemon next to one that will not stop", async () => {
    const { d } = deps(
      "linux",
      { daemonPid: vi.fn(async () => 4242) },
      (c) => c === "systemctl",
    );
    await systemService(d).ensure();
    expect(d.kill).toHaveBeenCalledWith(4242);
    expect(d.spawnDaemon).not.toHaveBeenCalled();
  });

  it("an enable that fails undoes the unit", async () => {
    const { d, calls, userHome } = deps(
      "linux",
      {},
      (_c, a) => a[1] === "restart",
    );
    await systemService(d).ensure();
    expect(existsSync(unitOf(userHome))).toBe(false);
    expect(calls.slice(-2)).toEqual([
      ["systemctl", ["--user", "disable", SYSTEMD_UNIT]],
      ["systemctl", ["--user", "daemon-reload"]],
    ]);
  });

  it("remove disables and deletes the unit", async () => {
    const { d, calls, userHome } = deps("linux");
    const s = systemService(d);
    await s.ensure();
    calls.length = 0;
    expect(await s.remove()).toEqual({ unit: "systemd" });
    expect(calls).toEqual([
      ["systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]],
      ["systemctl", ["--user", "daemon-reload"]],
    ]);
    expect(existsSync(unitOf(userHome))).toBe(false);
    expect(await s.remove()).toEqual({});
  });

  it("problems: lingering off, and a node path that is gone", async () => {
    const { d, userHome } = deps("linux", { execPath: process.execPath });
    const s = systemService(d);
    expect(s.problems?.()).toEqual([]);
    await s.ensure();
    expect(s.problems?.()).toEqual([{ kind: "linger-off" }]);
    mkdirSync(join(userHome, "linger"));
    writeFileSync(join(userHome, "linger/leo"), "");
    expect(s.problems?.()).toEqual([]);
    await systemService({ ...d, execPath: "/gone/node" }).ensure();
    expect(s.problems?.()).toEqual([
      { kind: "node-missing", node: "/gone/node" },
    ]);
  });
});

describe("systemService: no service manager", () => {
  it("runs the daemon in the background on other platforms", async () => {
    const { d, calls } = deps("freebsd");
    const s = systemService(d);
    await s.ensure();
    expect(calls).toEqual([]);
    expect(d.spawnDaemon).toHaveBeenCalledOnce();
    expect(s.kind).toBeUndefined();
    expect(await s.remove()).toEqual({});
  });
});

describe("tripwires", () => {
  it("the default exec refuses launchctl and systemctl under vitest", async () => {
    const exec = makeExec(1000);
    await expect(exec("launchctl", ["list"])).rejects.toThrow(/under vitest/);
    await expect(exec("/bin/systemctl", ["--user", "status"])).rejects.toThrow(
      /under vitest/,
    );
    await expect(realCtx(true).exec("launchctl", ["list"])).rejects.toThrow(
      /under vitest/,
    );
    expect(() => guardServiceManager("launchctl", [], {})).not.toThrow();
  });

  it("the real ctx's homes are the sentinel, whose service folders are checked", () => {
    const ctx = realCtx(true);
    expect(ctx.userHome).toBe(SENTINEL_HOME);
    expect(ctx.home).toBe(join(SENTINEL_HOME, ".oa-bus"));
    const dir = join(SENTINEL_HOME, "Library/LaunchAgents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x.plist"), "");
    try {
      expect(serviceWrites()).toEqual(["Library/LaunchAgents/x.plist"]);
    } finally {
      rmSync(join(dir, "x.plist"));
    }
    expect(serviceWrites()).toEqual([]);
  });
});

const cwd = process.cwd();

describe("systemService: OA_BUS_SERVICE", () => {
  it("the unit sets OA_BUS_SERVICE=1; the fallback daemon does not", async () => {
    const mac = deps("darwin");
    await systemService(mac.d).ensure();
    expect(
      readFileSync(
        join(mac.userHome, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`),
        "utf8",
      ),
    ).toContain("<key>OA_BUS_SERVICE</key><string>1</string>");
    const linux = deps("linux");
    await systemService(linux.d).ensure();
    expect(
      readFileSync(
        join(linux.userHome, ".config/systemd/user", SYSTEMD_UNIT),
        "utf8",
      ),
    ).toContain('Environment="OA_BUS_SERVICE=1"');
    const none = deps("freebsd");
    await systemService(none.d).ensure();
    expect(
      vi.mocked(none.d.spawnDaemon).mock.calls[0]?.[2].env,
    ).not.toHaveProperty("OA_BUS_SERVICE");
  });
});

describe("systemService: a daemon already running", () => {
  it("install stops a daemon running without a unit before starting the service", async () => {
    let pid: number | undefined = 4242;
    const order: string[] = [];
    const { d } = deps("darwin", {
      daemonPid: vi.fn(async () => pid),
      kill: vi.fn((p: number) => {
        order.push(`kill ${p}`);
        pid = undefined;
      }),
    });
    const exec = d.exec;
    d.exec = vi.fn(async (cmd: string, args: string[]) => {
      order.push(`${cmd} ${args[0]}`);
      return exec(cmd, args);
    });
    await systemService(d).ensure();
    expect(order).toEqual([
      "launchctl bootout",
      "kill 4242",
      "launchctl bootstrap",
    ]);
  });

  it("a reinstall stops the unit first, and signals nothing the unit stopped", async () => {
    let up = true;
    const { d, calls } = deps("linux");
    const s = systemService(d);
    await s.ensure();
    calls.length = 0;
    d.daemonPid = vi.fn(async () => (up ? 4242 : undefined));
    const exec = d.exec;
    d.exec = vi.fn(async (cmd: string, args: string[]) => {
      if (args[1] === "stop") up = false;
      return exec(cmd, args);
    });
    await s.ensure();
    expect(d.kill).not.toHaveBeenCalled();
    expect(calls[0]).toEqual(["systemctl", ["--user", "stop", SYSTEMD_UNIT]]);
  });

  it("macOS: a failed bootstrap waits for the booted-out daemon, then falls back", async () => {
    // bootout returned; the old daemon answers a moment longer, then goes.
    const answers: (number | undefined)[] = [undefined, 7, 7, undefined];
    const { d } = deps(
      "darwin",
      { daemonPid: vi.fn(async () => answers.shift()) },
      (_c, a) => a[0] === "bootstrap",
    );
    const s = systemService(d);
    await s.ensure();
    expect(d.spawnDaemon).toHaveBeenCalledOnce();
    expect(s.kind).toBeUndefined();
    expect(s.fallback).toBe(true);
  });

  it("uninstall stops the fallback's daemon and says so", async () => {
    let pid: number | undefined;
    const { d } = deps(
      "linux",
      {
        daemonPid: vi.fn(async () => pid),
        spawnDaemon: vi.fn(() => {
          pid = 5150;
          return pid;
        }),
        kill: vi.fn(() => {
          pid = undefined;
        }),
      },
      () => true,
    );
    const s = systemService(d);
    await s.ensure();
    expect(pid).toBe(5150);
    expect(await s.remove()).toEqual({ stopped: true });
    expect(d.kill).toHaveBeenCalledWith(5150);
    expect(pid).toBeUndefined();
    expect(s.fallback).toBe(false);
    expect(await s.remove()).toEqual({});
  });
});

describe("systemService: unit paths", () => {
  afterEach(() => process.chdir(cwd));

  it("an empty or relative XDG_CONFIG_HOME means ~/.config, as in systemd", async () => {
    for (const xdg of ["", "rel"]) {
      const work = tmp();
      process.chdir(work);
      const { d, userHome } = deps("linux", {
        env: { PATH: "/usr/bin", XDG_CONFIG_HOME: xdg },
      });
      await systemService(d).ensure();
      expect(existsSync(join(work, xdg, "systemd/user", SYSTEMD_UNIT))).toBe(
        false,
      );
      expect(
        existsSync(join(userHome, ".config/systemd/user", SYSTEMD_UNIT)),
      ).toBe(true);
    }
  });

  it("uninstall removes the unit install recorded, whatever XDG_CONFIG_HOME is now", async () => {
    const xdg = tmp();
    const { d, home } = deps("linux", {
      env: { PATH: "/usr/bin", XDG_CONFIG_HOME: xdg },
    });
    await systemService(d).ensure();
    expect(
      JSON.parse(readFileSync(join(home, "install.json"), "utf8")).service.unit,
    ).toBe(join(xdg, "systemd/user", SYSTEMD_UNIT));
    const later = systemService({ ...d, env: { PATH: "/usr/bin" } });
    expect(later.kind).toBe("systemd");
    expect(await later.remove()).toEqual({ unit: "systemd" });
    expect(existsSync(join(xdg, "systemd/user", SYSTEMD_UNIT))).toBe(false);
  });

  it("a relative OA_BUS_HOME reaches the plist absolute", async () => {
    const work = tmp();
    process.chdir(work);
    const { d, userHome } = deps("darwin", { home: () => "rel-bus" });
    await systemService(d).ensure();
    const { label } = serviceNames(join(process.cwd(), "rel-bus"), userHome);
    const plist = readFileSync(
      join(userHome, "Library/LaunchAgents", `${label}.plist`),
      "utf8",
    );
    const paths = [...plist.matchAll(/<string>([^<]*rel-bus[^<]*)<\/string>/g)];
    expect(paths.length).toBeGreaterThan(0);
    for (const m of paths) expect(isAbsolute(m[1] as string)).toBe(true);
  });

  it("realCtx resolves a relative OA_BUS_HOME", () => {
    const saved = process.env.OA_BUS_HOME;
    process.env.OA_BUS_HOME = "rel-bus";
    try {
      expect(realCtx(true).home).toBe(join(process.cwd(), "rel-bus"));
    } finally {
      process.env.OA_BUS_HOME = saved;
    }
  });

  it("replaces a symlinked plist or unit, never writing into its target", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const { d, userHome } = deps(platform);
      const file =
        platform === "darwin"
          ? join(userHome, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`)
          : join(userHome, ".config/systemd/user", SYSTEMD_UNIT);
      mkdirSync(join(file, ".."), { recursive: true });
      const target = join(tmp(), "dotfiles");
      writeFileSync(target, "mine");
      symlinkSync(target, file);
      await systemService(d).ensure();
      expect(readFileSync(target, "utf8")).toBe("mine");
      expect(readFileSync(file, "utf8")).toContain("bin/dist/index.js");
    }
  });

  it("tightens OA_BUS_HOME and bin to 0700", () => {
    const home = join(tmp(), "bus");
    mkdirSync(home);
    chmodSync(home, 0o777);
    const pkg = tmp();
    mkdirSync(join(pkg, "dist"));
    writeFileSync(join(pkg, "dist/index.js"), "// bundle");
    installCli(home, { kind: "bundle", file: join(pkg, "dist/index.js") });
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "bin")).mode & 0o777).toBe(0o700);
  });
});

describe("the vitest guard, wrapped", () => {
  it("refuses launchctl or systemctl through env or a shell", async () => {
    // PATH holds neither, so nothing real could run if the guard missed.
    const saved = process.env.PATH;
    process.env.PATH = tmp();
    try {
      const exec = makeExec(2000);
      await expect(exec("/usr/bin/env", ["launchctl", "list"])).rejects.toThrow(
        /refusing/,
      );
      for (const sh of ["sh", "/bin/bash", "zsh"])
        await expect(
          exec(sh, ["-c", "systemctl --user start oa-bus"]),
        ).rejects.toThrow(/refusing/);
      expect(() => guardServiceManager("sh", ["-c", "echo hi"])).not.toThrow();
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe("systemService: a daemon that will not stop (round 2)", () => {
  it("install starts nothing while the old daemon still answers after the wait", async () => {
    const { d, calls } = deps("darwin", { daemonPid: vi.fn(async () => 4242) });
    expect(await systemService(d).ensure()).toEqual({ running: 4242 });
    expect(d.kill).toHaveBeenCalledWith(4242);
    expect(calls.some(([, a]) => a[0] === "bootstrap")).toBe(false);
    expect(d.spawnDaemon).not.toHaveBeenCalled();
  });

  it("a reinstall over a running service waits for the booted-out daemon before bootstrap", async () => {
    let dying = 0;
    let early = false;
    const { d } = deps("darwin", {
      daemonPid: vi.fn(async () => (dying-- > 0 ? 4242 : undefined)),
      exec: vi.fn(async (_cmd: string, args: string[]) => {
        if (args[0] === "bootout") dying = 3;
        if (args[0] === "bootstrap" && dying > 0) early = true;
        return { code: 0, stdout: "", stderr: "" };
      }),
    });
    const s = systemService(d);
    await s.ensure();
    await s.ensure();
    expect(early).toBe(false);
  });

  it("a booted-out daemon that never stops: no bootstrap", async () => {
    const { d, calls } = deps("darwin");
    const s = systemService(d);
    await s.ensure();
    d.daemonPid = vi.fn(async () => 4242);
    calls.length = 0;
    expect(await s.ensure()).toEqual({ running: 4242 });
    expect(calls.map(([, a]) => a[0])).toEqual(["bootout"]);
  });

  it("uninstall reports a daemon that still answers and keeps the record", async () => {
    const { d, home } = deps("linux", { daemonPid: vi.fn(async () => 4242) });
    const s = systemService(d);
    expect(await s.remove()).toEqual({ running: 4242 });
    const { d: d2, home: h2 } = deps("linux");
    const s2 = systemService(d2);
    await s2.ensure();
    d2.daemonPid = vi.fn(async () => 4242);
    expect(await s2.remove()).toEqual({ unit: "systemd", running: 4242 });
    expect(
      JSON.parse(readFileSync(join(h2, "install.json"), "utf8")).service.kind,
    ).toBe("systemd");
    expect(home).toBeTruthy();
  });

  it("never SIGTERMs a pid that is not an Open Artifacts bus daemon", async () => {
    // A daemon in another pid namespace answers; its pid is a host process.
    const { d } = deps("darwin", {
      daemonPid: vi.fn(async () => 777),
      processArgs: () => "/usr/bin/python3 -m http.server",
    });
    expect(await systemService(d).ensure()).toEqual({ running: 777 });
    expect(d.kill).not.toHaveBeenCalled();
    const gone = deps("linux", {
      daemonPid: vi.fn(async () => 778),
      processArgs: () => undefined,
    });
    expect(await systemService(gone.d).remove()).toEqual({ running: 778 });
    expect(gone.d.kill).not.toHaveBeenCalled();
  });

  it("isOurDaemon: our copy or a terminal oa-bus daemon, nothing else", () => {
    const entry = "/Users/a b/.oa-bus/bin/oa-bus.js";
    expect(isOurDaemon(`/opt/node ${entry} daemon`, entry)).toBe(true);
    expect(isOurDaemon("node /x/bin/oa-bus.mjs daemon", entry)).toBe(true);
    expect(
      isOurDaemon("node /x/_npx/1/node_modules/.bin/oa-bus daemon", entry),
    ).toBe(true);
    // The published bundle run straight from a package, an npx cache included.
    expect(
      isOurDaemon("node /x/node_modules/oa-bus/dist/index.js daemon", entry),
    ).toBe(true);
    expect(isOurDaemon("node /x/other/dist/index.js daemon", entry)).toBe(
      false,
    );
    expect(isOurDaemon(`/opt/node ${entry} mcp claude`, entry)).toBe(false);
    expect(isOurDaemon("node /x/not-oa-bus daemon", entry)).toBe(false);
    expect(isOurDaemon("vim oa-bus daemon.md", entry)).toBe(false);
  });
});

describe("systemService: one label per home (round 2)", () => {
  it("the default home keeps the plain names; another gets a stable hash", () => {
    const u = "/Users/leo";
    expect(serviceNames("/Users/leo/.oa-bus", u)).toEqual({
      label: LAUNCHD_LABEL,
      unit: SYSTEMD_UNIT,
    });
    const a = serviceNames("/Users/leo/bus-a", u);
    expect(a).toEqual(serviceNames("/Users/leo/bus-a/", u));
    expect(a.unit).toMatch(/^oa-bus-[0-9a-f]{8}\.service$/);
    expect(a).not.toEqual(serviceNames("/Users/leo/bus-b", u));
  });

  it("uninstall from one OA_BUS_HOME leaves another home's service", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const userHome = tmp();
      const a = deps(platform, { home: () => join(userHome, "bus-a") });
      const b = deps(platform, { home: () => join(userHome, "bus-b") });
      const da = { ...a.d, userHome };
      const db = { ...b.d, userHome };
      await systemService(da).ensure();
      await systemService(db).ensure();
      expect(await systemService(da).remove()).toMatchObject({
        unit: platform === "darwin" ? "launchd" : "systemd",
      });
      expect(systemService(db).kind).toBe(
        platform === "darwin" ? "launchd" : "systemd",
      );
      expect(systemService(da).kind).toBeUndefined();
    }
  });

  it("never deletes a recorded unit that is not ours", async () => {
    const { d, home, userHome } = deps("darwin");
    mkdirSync(home, { recursive: true });
    const theirs = join(userHome, "Library/LaunchAgents/com.apple.thing.plist");
    mkdirSync(join(theirs, ".."), { recursive: true });
    writeFileSync(theirs, "theirs");
    writeFileSync(
      join(home, "install.json"),
      JSON.stringify({ service: { kind: "launchd", unit: theirs } }),
    );
    const s = systemService(d);
    expect(await s.remove()).toEqual({});
    await s.ensure();
    expect(readFileSync(theirs, "utf8")).toBe("theirs");
  });

  it("a moved XDG_CONFIG_HOME: ensure removes the old unit", async () => {
    const x1 = tmp();
    const x2 = tmp();
    const { d } = deps("linux", {
      env: { PATH: "/usr/bin", XDG_CONFIG_HOME: x1 },
    });
    await systemService(d).ensure();
    await systemService({
      ...d,
      env: { PATH: "/usr/bin", XDG_CONFIG_HOME: x2 },
    }).ensure();
    expect(existsSync(join(x1, "systemd/user", SYSTEMD_UNIT))).toBe(false);
    expect(existsSync(join(x2, "systemd/user", SYSTEMD_UNIT))).toBe(true);
  });

  it("a failed replace leaves no temp file behind", async () => {
    const { d, userHome } = deps("darwin");
    const dir = join(userHome, "Library/LaunchAgents");
    // A directory where the plist goes: the rename fails.
    mkdirSync(join(dir, `${LAUNCHD_LABEL}.plist`, "x"), { recursive: true });
    await expect(systemService(d).ensure()).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([`${LAUNCHD_LABEL}.plist`]);
  });
});

describe("the vitest guard, any wrapper (round 2)", () => {
  it("refuses launchctl or systemctl anywhere in the argv", async () => {
    const saved = process.env.PATH;
    process.env.PATH = tmp();
    try {
      const exec = makeExec(2000);
      for (const [cmd, args] of [
        ["/usr/bin/nohup", ["launchctl", "list"]],
        ["timeout", ["5", "/bin/systemctl", "--user", "status"]],
        ["xargs", ["launchctl"]],
        ["dash", ["-c", "systemctl --user start x"]],
        ["fish", ["-c", "launchctl list"]],
      ] as [string, string[]][])
        await expect(exec(cmd, args)).rejects.toThrow(/refusing/);
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe("round 3: our daemon, found without ps", () => {
  it("uninstall stops the fallback daemon install started where ps is missing", async () => {
    let alive = false;
    const { d, home } = deps(
      "linux",
      {
        daemonPid: vi.fn(async () => (alive ? 4242 : undefined)),
        processArgs: () => undefined,
        kill: vi.fn(() => {
          alive = false;
        }),
        spawnDaemon: vi.fn(() => {
          alive = true;
          return 4242;
        }),
      },
      () => true,
    );
    const s = systemService(d);
    await s.ensure();
    expect(
      JSON.parse(readFileSync(join(home, "install.json"), "utf8")).service,
    ).toEqual({ fallback: true, pid: 4242 });
    expect(await s.remove()).toEqual({ stopped: true });
    expect(d.kill).toHaveBeenCalledWith(4242);
  });

  it("without ps, a pid that is not the recorded one is never signalled", async () => {
    const { d } = deps("linux", {
      daemonPid: vi.fn(async () => 999),
      processArgs: () => undefined,
    });
    expect(await systemService(d).remove()).toEqual({ running: 999 });
    expect(d.kill).not.toHaveBeenCalled();
  });

  it("stopDaemon's ps comes from the system dirs, not a ps earlier on PATH (C26j)", () => {
    const bin = mkdtempSync(join(tmpdir(), "ob-path-"));
    // A planted ps that would make any pid look like our daemon.
    writeFileSync(
      join(bin, "ps"),
      "#!/bin/sh\necho node /usr/local/bin/oa-bus daemon\n",
    );
    chmodSync(join(bin, "ps"), 0o755);
    const path = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${path}`;
      const args = processArgs(process.pid);
      expect(args).toBeDefined();
      expect(args).not.toContain("oa-bus daemon");
    } finally {
      process.env.PATH = path;
    }
  });

  it("runs launchctl and systemctl by absolute path, user tools by name (C26j)", () => {
    for (const tool of ["launchctl", "systemctl"]) {
      const r = resolveCmd(tool);
      if (r !== tool) expect(r).toMatch(new RegExp(`^/(usr/)?s?bin/${tool}$`));
    }
    if (process.platform === "darwin")
      expect(resolveCmd("launchctl")).toBe("/bin/launchctl");
    expect(resolveCmd("opencode")).toBe("opencode");
  });

  it("processArgs falls back to /proc/<pid>/cmdline", () => {
    const io = {
      ps: () => {
        throw Object.assign(new Error("spawn ps ENOENT"), { code: "ENOENT" });
      },
      proc: (path: string) => {
        expect(path).toBe("/proc/42/cmdline");
        return "node\0/home/a b/.oa-bus/bin/oa-bus.js\0daemon\0";
      },
    };
    expect(processArgs(42, io)).toBe(
      "node /home/a b/.oa-bus/bin/oa-bus.js daemon",
    );
    expect(
      processArgs(42, {
        ...io,
        proc: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toBeUndefined();
    expect(processArgs(process.pid)).toContain("node");
  });
});

describe("round 3: every terminal daemon", () => {
  const entry = "/Users/a b/.oa-bus/bin/oa-bus.js";
  it.each([
    "node /usr/local/bin/oa-bus --no-color daemon",
    "node /usr/local/bin/oa-bus --home /tmp/x daemon",
    "node /usr/local/bin/oa-bus --home=/tmp/x --no-color daemon --instance wss://h",
    "node /usr/local/bin/oa-bus daemon --home /tmp/x",
    `/opt/node ${entry} --no-color daemon`,
  ])("ours: %s", (args) => expect(isOurDaemon(args, entry)).toBe(true));

  it.each([
    "node /usr/local/bin/oa-bus --home daemon status",
    "node /usr/local/bin/oa-bus status daemon",
    "node /usr/local/bin/oa-bus --no-color mcp claude",
  ])("not ours: %s", (args) => expect(isOurDaemon(args, entry)).toBe(false));

  it("a reinstall stops a terminal daemon even when the unit is installed", async () => {
    let terminal = false;
    const kill = vi.fn(() => {
      terminal = false;
    });
    const { d } = deps("linux", {
      daemonPid: vi.fn(async () => (terminal ? 99 : undefined)),
      kill,
    });
    const s = systemService(d);
    await s.ensure();
    terminal = true;
    expect(await s.ensure()).toEqual({});
    expect(kill).toHaveBeenCalledWith(99);
  });
});

describe("round 3: homes", () => {
  it("the default home through a symlinked HOME keeps the plain names", () => {
    const realHome = tmp();
    mkdirSync(join(realHome, ".oa-bus"));
    const link = join(tmp(), "home-link");
    symlinkSync(realHome, link);
    expect(serviceNames(join(realpathSync(link), ".oa-bus"), link)).toEqual({
      label: LAUNCHD_LABEL,
      unit: SYSTEMD_UNIT,
    });
    expect(isDefaultHome(join(realHome, ".oa-bus"), link)).toBe(true);
  });

  it("a moved XDG path disables the old unit before deleting it", async () => {
    const x1 = tmp();
    const { d, calls } = deps("linux", {
      env: { PATH: "/usr/bin", XDG_CONFIG_HOME: x1 },
    });
    await systemService(d).ensure();
    calls.length = 0;
    await systemService({
      ...d,
      env: { PATH: "/usr/bin", XDG_CONFIG_HOME: tmp() },
    }).ensure();
    const disable = calls.findIndex(
      ([, a]) => a[1] === "disable" && a[2] === SYSTEMD_UNIT,
    );
    const reload = calls.findIndex(([, a]) => a[1] === "daemon-reload");
    expect(disable).toBeGreaterThanOrEqual(0);
    expect(disable).toBeLessThan(reload);
    expect(existsSync(join(x1, "systemd/user", SYSTEMD_UNIT))).toBe(false);
  });
});
