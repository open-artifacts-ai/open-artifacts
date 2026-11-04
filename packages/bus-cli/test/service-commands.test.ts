import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { doctor } from "../src/commands/doctor.ts";
import { install } from "../src/commands/install.ts";
import { status as statusCmd } from "../src/commands/status.ts";
import { uninstall } from "../src/commands/uninstall.ts";
import { main } from "../src/main.ts";
import {
  LAUNCHD_LABEL,
  type ServiceDeps,
  systemService,
} from "../src/steps/service.ts";
import {
  deviceCode,
  type Fake,
  fakeCtx,
  HUB,
  LABEL,
  status,
  TOKEN,
} from "./fake.ts";

/** The real service on a fake ctx: exec, home and the daemon are all fakes. */
function withService(
  platform: NodeJS.Platform,
  fail: (cmd: string, args: string[]) => boolean = () => false,
  over: Partial<ServiceDeps> = {},
) {
  const calls: string[] = [];
  let up = false;
  const pkg = mkdtempSync(join(tmpdir(), "ob-pkg-"));
  mkdirSync(join(pkg, "dist"));
  writeFileSync(join(pkg, "dist/index.js"), "// bundle");
  const ctx: Fake = fakeCtx({
    exec: vi.fn(async (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (fail(cmd, args)) return { code: 1, stdout: "", stderr: "no bus" };
      // The service manager starting the daemon.
      if (args[0] === "bootstrap" || args[1] === "restart") up = true;
      if (args[0] === "bootout" || args[1] === "disable") up = false;
      return { code: 0, stdout: "", stderr: "" };
    }),
    status: vi.fn(async () => {
      if (!up) throw new Error("ECONNREFUSED");
      return status();
    }),
  });
  const spawnDaemon = vi.fn(() => {
    up = true;
    return 48213;
  });
  ctx.service = systemService({
    platform,
    userHome: ctx.userHome,
    home: () => ctx.home,
    env: { PATH: "/usr/bin" },
    exec: ctx.exec,
    sleep: ctx.sleep,
    execPath: process.execPath,
    uid: 501,
    user: "leo",
    lingerDir: join(ctx.userHome, "linger"),
    source: () => ({ kind: "bundle", file: join(pkg, "dist/index.js") }),
    daemonPid: async () => (up ? 48213 : undefined),
    // A terminal run of ours, unless a test says otherwise.
    processArgs: () => "node /usr/local/bin/oa-bus daemon",
    kill: vi.fn(() => {
      up = false;
    }),
    spawnDaemon,
    ...over,
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
  return { ctx, calls, spawnDaemon, isUp: () => up };
}

const plistOf = (ctx: Fake) =>
  join(ctx.userHome, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const RUNNING_LAUNCHD =
  "[[success]]✓[[/success]]  Daemon running as a launchd service  [[muted]]pid 48213[[/muted]]";
const NO_SERVICE = [
  "[[warning]]![[/warning]]  Daemon running, but no service will restart it after a reboot.",
  "   Run npx @open-artifacts/bus install.",
];

const FALLBACK = [
  "[[warning]]![[/warning]]  Daemon running without a service, so it won't restart after a reboot.",
  "   After a reboot, start it again with npx @open-artifacts/bus daemon.",
];

describe("install through the service", () => {
  it("starts the launchd service, then prints Daemon running once the socket answers", async () => {
    const { ctx, calls } = withService("darwin");
    expect(await install({ hub: HUB }, ctx)).toBe(0);
    expect(calls).toContain(`launchctl bootstrap gui/501 ${plistOf(ctx)}`);
    expect(existsSync(join(ctx.home, "bin/dist/index.js"))).toBe(true);
    expect(ctx.out()).toContain(RUNNING_LAUNCHD);
    expect(ctx.out()).not.toContain(NO_SERVICE[0]);
  });

  it("points the MCP entries at the stable copy, run by this node", async () => {
    const { ctx, calls } = withService("darwin");
    // Neither OA_BUS_BIN nor argv[1]: both may be an npx cache path.
    ctx.env = { OA_BUS_BIN: "/tmp/_npx/oa-bus" };
    ctx.which = (c) => c === "opencode" || c === "claude";
    const exec = ctx.exec;
    ctx.exec = vi.fn(async (cmd: string, args: string[]) =>
      cmd === "opencode" && args[0] === "--version"
        ? { code: 0, stdout: "opencode v2.0.32\n", stderr: "" }
        : exec(cmd, args),
    );
    expect(await install({ hub: HUB }, ctx)).toBe(0);
    const entry = join(ctx.home, "bin/dist/index.js");
    const oc = JSON.parse(
      readFileSync(
        join(ctx.userHome, ".config/opencode/opencode.json"),
        "utf8",
      ),
    );
    expect(oc.mcp.servers.oa_bus.command).toEqual([
      process.execPath,
      entry,
      "mcp",
      "opencode",
    ]);
    expect(existsSync(entry)).toBe(true);
    expect(calls).toContain(
      `claude mcp add --scope user oa_bus -- ${process.execPath} ${entry} mcp claude`,
    );
  });

  it("a daemon that will not stop: the × line, and nothing started", async () => {
    const { ctx, calls } = withService("darwin", () => false, {
      daemonPid: async () => 4242,
      kill: vi.fn(),
    });
    expect(await install({ hub: HUB }, ctx)).toBe(1);
    expect(calls.some((c) => c.includes("bootstrap"))).toBe(false);
    expect(ctx.err()).toEqual([
      "[[danger]]×[[/danger]]  Another daemon is still running (pid 4242) on ~/.oa-bus/daemon.sock.",
      "   Stop it with kill 4242, then run npx @open-artifacts/bus install again.",
    ]);
  });

  it("systemd: names the user service", async () => {
    const { ctx } = withService("linux");
    expect(await install({ hub: HUB }, ctx)).toBe(0);
    expect(ctx.out()).toContain(
      "[[success]]✓[[/success]]  Daemon running as a systemd user service  [[muted]]pid 48213[[/muted]]",
    );
  });

  it("no systemd user session: runs the daemon itself, and says how to start it after a reboot", async () => {
    const { ctx, spawnDaemon } = withService("linux", (c) => c === "systemctl");
    expect(await install({ hub: HUB }, ctx)).toBe(0);
    expect(spawnDaemon).toHaveBeenCalledOnce();
    // Not "Run npx @open-artifacts/bus install": install just ran, and fell back.
    expect(ctx.out()).toEqual(expect.arrayContaining(FALLBACK));
    expect(ctx.out()).not.toContain(NO_SERVICE[1]);
    // status says the same thing afterwards.
    expect(await statusCmd(ctx)).toBe(0);
    expect(ctx.out().filter((l) => l === FALLBACK[1])).toHaveLength(2);
  });

  it("a service that never answers is the 10 s failure", async () => {
    // Neither launchd nor the fallback daemon ever answers.
    const { ctx } = withService("darwin", (_c, a) => a[0] === "bootstrap", {
      daemonPid: async () => undefined,
      spawnDaemon: () => undefined,
    });
    expect(await install({ hub: HUB }, ctx)).toBe(1);
    expect(ctx.err()[0]).toBe(
      "[[danger]]×[[/danger]]  The daemon did not start within 10 seconds.",
    );
  });
});

describe("status and doctor report the service", () => {
  it("status: the no-service line only while no service is installed", async () => {
    const a = withService("darwin", () => false);
    a.ctx.status = vi.fn(async () => status());
    expect(await statusCmd(a.ctx)).toBe(0);
    expect(a.ctx.out()).toEqual(expect.arrayContaining(NO_SERVICE));

    const b = withService("darwin");
    await b.ctx.service.ensure();
    expect(await statusCmd(b.ctx)).toBe(0);
    expect(b.ctx.out()).toContain(RUNNING_LAUNCHD);
    expect(b.ctx.out()).not.toContain(NO_SERVICE[0]);
  });

  it("doctor: the service passes; a gone node fails, lingering off warns", async () => {
    const { ctx } = withService("linux", () => false, {
      execPath: "/gone/node",
    });
    ctx.fetch = vi.fn(async () => new Response("ok")) as never;
    await ctx.service.ensure();
    // A gone Node fails: after a reboot the service cannot start.
    expect(await doctor(ctx)).toBe(1);
    expect(ctx.all()).toEqual(
      expect.arrayContaining([
        "[[success]]✓[[/success]]  Daemon running as a systemd user service  [[muted]]pid 48213[[/muted]]",
        "[[danger]]×[[/danger]]  The service runs a Node that is gone: /gone/node.",
        "   Run npx @open-artifacts/bus install to point it at your current Node.",
        "[[warning]]![[/warning]]  The daemon stops when you log out (systemd lingering is off).",
        "   Run loginctl enable-linger $USER to keep it running.",
        "[[muted]]1 failed, 1 warning, 4 passed.[[/muted]]",
      ]),
    );
    expect(ctx.out()).not.toContain(NO_SERVICE[0]);
  });
});

describe("uninstall through the service", () => {
  it("stops the service and removes the plist; the second run has none", async () => {
    const { ctx, calls, isUp } = withService("darwin");
    await ctx.service.ensure();
    expect(isUp()).toBe(true);
    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(calls.at(-1)).toBe(`launchctl bootout gui/501/${LAUNCHD_LABEL}`);
    expect(existsSync(plistOf(ctx))).toBe(false);
    expect(isUp()).toBe(false);
    expect(ctx.out()).toContain(
      "[[success]]✓[[/success]]  Stopped and removed the launchd service",
    );
    const again = await uninstall({ purge: false }, ctx);
    expect(again).toBe(0);
    expect(ctx.out()).toContain(
      "[[success]]✓[[/success]]  No service to remove",
    );
  });

  it("stops the fallback's daemon", async () => {
    const { ctx, isUp } = withService("linux", (c) => c === "systemctl");
    await ctx.service.ensure();
    expect(isUp()).toBe(true);
    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(isUp()).toBe(false);
    expect(ctx.out()).toContain("[[success]]✓[[/success]]  Stopped the daemon");
  });

  it("a daemon that still answers is reported, not called stopped", async () => {
    const { ctx } = withService("linux", () => false, {
      daemonPid: async () => 4242,
      processArgs: () => "/usr/bin/python3 -m http.server",
    });
    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(ctx.out()).toEqual(
      expect.arrayContaining([
        "[[warning]]![[/warning]]  The daemon is still running (pid 4242).",
        "   Stop it with kill 4242.",
      ]),
    );
    expect(ctx.out()).not.toContain(
      "[[success]]✓[[/success]]  Stopped the daemon",
    );
    expect(ctx.out()).not.toContain(
      "[[success]]✓[[/success]]  No service to remove",
    );
  });

  it("--purge after the stop removes <home>/bin too", async () => {
    const { ctx } = withService("linux");
    await ctx.service.ensure();
    expect(await uninstall({ purge: true }, ctx)).toBe(0);
    expect(existsSync(join(ctx.home, "bin"))).toBe(false);
    expect(ctx.out()).toContain(
      "[[success]]✓[[/success]]  Stopped and removed the systemd user service",
    );
  });
});

describe("a revoked machine (C14): why the copy says install, not login", () => {
  /** The service exited 0 on revoke, so nothing restarts it; the hub approves again. */
  const revoked = () => {
    const w = withService("darwin");
    writeFileSync(join(w.ctx.home, "revoked"), "{}\n");
    w.ctx.fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/bus/device")
        ? deviceCode()
        : Response.json({
            status: "approved",
            machine_token: TOKEN,
          }),
    ) as unknown as typeof fetch;
    return w;
  };

  it("install re-approves, clears the marker and starts the service", async () => {
    const { ctx, calls, isUp } = revoked();
    expect(await install({}, ctx)).toBe(0);
    expect(existsSync(join(ctx.home, "revoked"))).toBe(false);
    expect(calls).toContain(`launchctl bootstrap gui/501 ${plistOf(ctx)}`);
    expect(isUp()).toBe(true);
  });

  it("login alone re-approves but never touches the service", async () => {
    const { ctx, calls, isUp } = revoked();
    expect(await main(["login"], () => ctx)).toBe(0);
    expect(existsSync(join(ctx.home, "revoked"))).toBe(false);
    expect(calls.filter((c) => c.startsWith("launchctl"))).toEqual([]);
    expect(isUp()).toBe(false);
  });
});
