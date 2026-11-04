import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Service, ServiceProblem } from "../context.ts";
import type { Deps } from "../deps.ts";
import type { Env } from "../term.ts";
import { codexHomeEnv } from "./codex.ts";
import { readInstallFile, updateInstallFile } from "./step.ts";

export const LAUNCHD_LABEL = "com.open-artifacts.bus";
export const SYSTEMD_UNIT = "oa-bus.service";
/** EX_CONFIG: the daemon's exit on revoke. systemd never restarts it. */
export const REVOKED_EXIT = 78;
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";
const STOP_WAIT_MS = 5000;
const POLL_MS = 250;

/** What the service runs: `<node> <entry> daemon`, with `env`, logging to `out` and `err`. */
export type Unit = {
  node: string;
  entry: string;
  env: Record<string, string>;
  out: string;
  err: string;
};

/** A line break would end the value and start a key or directive of its own. */
const oneLine = (v: string) => {
  if (/[\r\n\0]/.test(v))
    throw new Error(
      `refusing a service value with a line break: ${JSON.stringify(v)}`,
    );
  return v;
};

const xml = (v: string) =>
  oneLine(v)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export function renderPlist(u: Unit, label = LAUNCHD_LABEL): string {
  const str = (v: string) => `<string>${xml(v)}</string>`;
  const env = Object.entries(u.env)
    .map(([k, v]) => `<key>${xml(k)}</key>${str(v)}`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>${str(u.node)}${str(u.entry)}${str("daemon")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key>${str(u.out)}
  <key>StandardErrorPath</key>${str(u.err)}
  <key>EnvironmentVariables</key>
  <dict>${env}</dict>
</dict>
</plist>
`;
}

/** systemd expands `%` specifiers everywhere. */
const specifiers = (v: string) => oneLine(v).replaceAll("%", "%%");
/** A double-quoted word: C escapes for `\` and `"`. */
const quoted = (v: string) =>
  `"${specifiers(v).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
/** ExecStart also expands `$VAR`. */
const execWord = (v: string) => quoted(v.replaceAll("$", "$$$$"));

export function renderSystemd(u: Unit): string {
  const env = Object.entries(u.env)
    .map(([k, v]) => `Environment=${quoted(`${k}=${v}`)}\n`)
    .join("");
  return `[Unit]
Description=Open Artifacts bus daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${execWord(u.node)} ${execWord(u.entry)} daemon
Restart=on-failure
RestartSec=10
RestartPreventExitStatus=${REVOKED_EXIT}
${env}StandardOutput=append:${specifiers(u.out)}
StandardError=append:${specifiers(u.err)}

[Install]
WantedBy=default.target
`;
}

/**
 * The CLI the service runs. Under npx the running copy lives in a cache that
 * is cleaned, so install copies it to `<OA_BUS_HOME>/bin` first.
 */
export type CliSource =
  /** The bundle, `<package>/dist/index.js`, with `<package>/assets`. */
  | { kind: "bundle"; file: string }
  /** The TypeScript sources through jiti, in the workspace. */
  | { kind: "dev"; main: string; jiti: string };

export function cliSource(): CliSource {
  const here = fileURLToPath(import.meta.url);
  return here.endsWith(".ts")
    ? {
        kind: "dev",
        main: fileURLToPath(new URL("../main.ts", import.meta.url)),
        jiti: import.meta.resolve("jiti"),
      }
    : { kind: "bundle", file: here };
}

/** The entry under `<home>/bin`: the bundle keeps the package's layout. */
const entryName = (src: CliSource) =>
  src.kind === "bundle"
    ? join(basename(dirname(src.file)), basename(src.file))
    : "oa-bus.js";

const shim = (src: { main: string; jiti: string }) =>
  `// Written by oa-bus install: runs the sources it was installed from.
import { createJiti } from ${JSON.stringify(src.jiti)};

const jiti = createJiti(${JSON.stringify(src.main)});
const { main } = await jiti.import(${JSON.stringify(src.main)});
const code = await main(process.argv.slice(2));
if (code !== undefined) process.exit(code);
`;

/**
 * Replaces `<home>/bin` with a copy of `src`; returns the entry to run. The
 * home and bin are 0700: whoever can write them picks what launchd runs.
 */
export function installCli(home: string, src: CliSource): string {
  const bin = join(home, "bin");
  const tmp = `${bin}.${process.pid}.tmp`;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  if (src.kind === "bundle") {
    // dist/index.js finds its assets at ../assets: copy the package's layout.
    const pkg = dirname(dirname(src.file));
    for (const name of ["dist", "assets", "package.json"])
      if (existsSync(join(pkg, name)))
        cpSync(join(pkg, name), join(tmp, name), { recursive: true });
  } else writeFileSync(join(tmp, entryName(src)), shim(src));
  chmodSync(tmp, 0o700);
  if (!existsSync(join(tmp, "package.json")))
    writeFileSync(join(tmp, "package.json"), '{ "type": "module" }\n');
  rmSync(bin, { recursive: true, force: true });
  renameSync(tmp, bin);
  return join(bin, entryName(src));
}

/** The file itself, a symlink included (existsSync follows the link). */
const present = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Temp file and rename: a symlink at `path` is replaced, never written through. */
function writeReplacing(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o644 });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * The launchd label and systemd unit for one OA_BUS_HOME. The default home
 * keeps the plain names; another gets a short hash of its path, so two homes
 * on one machine never share (or remove) each other's service.
 */
/**
 * The path with symlinks resolved through its nearest existing ancestor, the
 * missing tail appended: identical before and after the path is created.
 */
const real = (path: string): string => {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(real(parent), basename(abs));
  }
};

/** `<userHome>/.oa-bus`, compared by real path: HOME may be a symlink. */
export const isDefaultHome = (home: string, userHome: string) =>
  real(home) === real(join(userHome, ".oa-bus"));

export function serviceNames(home: string, userHome: string) {
  const suffix = isDefaultHome(home, userHome)
    ? ""
    : createHash("sha256").update(real(home)).digest("hex").slice(0, 8);
  return {
    label: suffix ? `${LAUNCHD_LABEL}.${suffix}` : LAUNCHD_LABEL,
    unit: suffix ? `oa-bus-${suffix}.service` : SYSTEMD_UNIT,
  };
}

/** The CLI's flags that take a value (index.ts): `--home X`, `--hub X`. */
const VALUE_FLAGS = new Set(["--home", "--hub"]);

/**
 * `node <entry> daemon` for this home, or `oa-bus daemon` run in a
 * terminal, with any global flags before the command.
 */
export function isOurDaemon(args: string, entry: string): boolean {
  // The entry's path may hold spaces: one word.
  const words = args.replaceAll(entry, "\0entry").split(/\s+/);
  const at = words.findIndex(
    (w) =>
      w === "\0entry" ||
      // The bin, the workspace shim, or the package's bundle (an npx cache).
      /(^|\/)oa-bus(\.m?js|\/dist\/index\.js)?$/.test(w),
  );
  if (at < 0) return false;
  for (let i = at + 1; i < words.length; i++) {
    const w = words[i] as string;
    if (VALUE_FLAGS.has(w)) i++;
    else if (!w.startsWith("-")) return w === "daemon";
  }
  return false;
}

export type ServiceDeps = {
  platform: NodeJS.Platform;
  userHome: string;
  /** OA_BUS_HOME, read on each call: `--home` sets it after the ctx is made. */
  home: () => string;
  env: Env;
  exec: Deps["exec"];
  sleep: Deps["sleep"];
  /** The node the service runs the CLI with. */
  execPath: string;
  uid: number;
  user: string;
  /** systemd-logind's linger flags; default /var/lib/systemd/linger. */
  lingerDir?: string;
  source: () => CliSource;
  /** The pid of the daemon answering on the socket; undefined when none does. */
  daemonPid: () => Promise<number | undefined>;
  /** A process's command line (`ps`, else /proc); undefined when unknown. */
  processArgs: (pid: number) => string | undefined;
  /** SIGTERM to that daemon. */
  kill: (pid: number) => void;
  /** Starts the daemon detached, when no service manager will. */
  spawnDaemon: (
    cmd: string,
    args: string[],
    opts: { env: Record<string, string>; out: string; err: string },
  ) => number | undefined;
};

type Record_ = {
  kind?: "launchd" | "systemd";
  node?: string;
  entry?: string;
  unit?: string;
  /** install could not start a service and ran the daemon itself. */
  fallback?: boolean;
  /** That daemon's pid: ours even where its args cannot be read. */
  pid?: number;
  /** The service's environment, OA_BUS_SERVICE aside: doctor compares CODEX_HOME. */
  env?: Record<string, string>;
};

/** launchd on macOS, systemd --user on Linux, else a background daemon. */
export function systemService(d: ServiceDeps): Service {
  const manager =
    d.platform === "darwin"
      ? "launchd"
      : d.platform === "linux"
        ? "systemd"
        : undefined;
  const home = () => resolve(d.home());
  const names = () => serviceNames(home(), d.userHome);
  const entryOf = () => join(home(), "bin", entryName(d.source()));
  const installFile = () => join(home(), "install.json");
  const record = (): Record_ => {
    const r = readInstallFile(installFile()).service;
    return typeof r === "object" && r !== null ? (r as Record_) : {};
  };
  // systemd ignores an empty or relative XDG_CONFIG_HOME.
  const xdg = d.env.XDG_CONFIG_HOME;
  const configHome = xdg && isAbsolute(xdg) ? xdg : join(d.userHome, ".config");
  const fileName = () =>
    manager === "launchd" ? `${names().label}.plist` : names().unit;
  const fresh = () =>
    manager === "launchd"
      ? join(d.userHome, "Library/LaunchAgents", fileName())
      : join(configHome, "systemd/user", fileName());
  /** The unit install recorded for this home, if it is one of ours. */
  const recorded = () => {
    const r = record().unit;
    return typeof r === "string" && isAbsolute(r) && basename(r) === fileName()
      ? r
      : undefined;
  };
  /** Where install wrote the unit; the env may differ at uninstall. */
  const file = () => {
    const r = recorded();
    return r && present(r) ? r : fresh();
  };
  const installed = () => manager !== undefined && present(file());
  const domain = `gui/${d.uid}`;
  const systemctl = (...args: string[]) =>
    d.exec("systemctl", ["--user", ...args]);

  /** Waits, bounded, for the socket to go quiet; the pid still answering, if any. */
  async function quiet(): Promise<number | undefined> {
    for (let waited = 0; ; waited += POLL_MS) {
      const pid = await d.daemonPid();
      if (pid === undefined || waited >= STOP_WAIT_MS) return pid;
      await d.sleep(POLL_MS);
    }
  }

  /** SIGTERMs the daemon on the socket if it is ours; the pid left answering. */
  async function stopDaemon(): Promise<number | undefined> {
    const pid = await d.daemonPid();
    if (pid === undefined) return undefined;
    const args = d.processArgs(pid);
    // A pid we cannot tie to our daemon is someone else's: never signal it.
    const ours =
      args === undefined
        ? record().fallback === true && record().pid === pid
        : isOurDaemon(args, entryOf());
    if (!ours) return pid;
    d.kill(pid);
    return quiet();
  }

  async function startLaunchd(
    f: string,
    u: Unit,
  ): Promise<"started" | "failed"> {
    writeReplacing(f, renderPlist(u, names().label));
    // bootstrap can race the bootout's teardown: one retry.
    for (let i = 0; i < 2; i++) {
      if ((await d.exec("launchctl", ["bootstrap", domain, f])).code === 0)
        return "started";
      await d.sleep(1000);
    }
    rmSync(f, { force: true });
    return "failed";
  }

  async function startSystemd(
    f: string,
    u: Unit,
  ): Promise<"started" | "failed"> {
    const unit = names().unit;
    writeReplacing(f, renderSystemd(u));
    for (const args of [
      ["daemon-reload"],
      ["enable", unit],
      // restart stops the old daemon before it starts the new one.
      ["restart", unit],
    ]) {
      if ((await systemctl(...args)).code === 0) continue;
      // No user session (WSL, a container): undo, and run it ourselves.
      if (args[0] !== "daemon-reload") await systemctl("disable", unit);
      rmSync(f, { force: true });
      if (args[0] !== "daemon-reload") await systemctl("daemon-reload");
      return "failed";
    }
    return "started";
  }

  return {
    get kind() {
      return installed() ? manager : undefined;
    },

    get fallback() {
      return !installed() && record().fallback === true;
    },

    async ensure() {
      const h = home();
      const src = d.source();
      const logs = join(h, "logs");
      const u: Unit = {
        node: d.execPath,
        entry: join(h, "bin", entryName(src)),
        env: {
          PATH: d.env.PATH ?? DEFAULT_PATH,
          ...(isDefaultHome(h, d.userHome) ? {} : { OA_BUS_HOME: h }),
          // Attestation and wake read the Codex home this shell uses (C26e).
          ...codexHomeEnv(d.userHome, d.env),
        },
        // One file: the daemon logs to stderr, and `oa-bus logs` tails it.
        out: join(logs, "daemon.log"),
        err: join(logs, "daemon.log"),
      };
      // A service's daemon exits 0 on a lasting failure: no restart loop.
      const unit: Unit = { ...u, env: { ...u.env, OA_BUS_SERVICE: "1" } };
      // Refuse a line break before anything is written.
      renderPlist(unit);
      // Stop the unit's daemon, then whatever else holds the socket (a
      // terminal's, the fallback's): the service's daemon would find it
      // taken. If it will not stop, start nothing.
      if (manager === "launchd")
        await d.exec("launchctl", ["bootout", `${domain}/${names().label}`]);
      else if (manager === "systemd" && installed())
        await systemctl("stop", names().unit);
      const left = await stopDaemon();
      if (left !== undefined) return { running: left };
      installCli(h, src);
      mkdirSync(logs, { recursive: true, mode: 0o700 });
      const f = fresh();
      // XDG_CONFIG_HOME moved since the last install: drop the old unit.
      const old = recorded();
      if (old && old !== f) {
        if (manager === "systemd") await systemctl("disable", names().unit);
        rmSync(old, { force: true });
      }
      const started =
        manager === "launchd"
          ? await startLaunchd(f, unit)
          : manager === "systemd"
            ? await startSystemd(f, unit)
            : "failed";
      if (started === "started") {
        updateInstallFile(installFile(), {
          service: {
            kind: manager,
            node: u.node,
            entry: u.entry,
            unit: f,
            env: u.env,
          } satisfies Record_,
        });
        return {};
      }
      // A booted-out daemon can answer a moment longer: wait it out.
      const still = await quiet();
      if (still !== undefined) return { running: still };
      const pid = d.spawnDaemon(u.node, [u.entry, "daemon"], {
        env: u.env,
        out: u.out,
        err: u.err,
      });
      updateInstallFile(installFile(), {
        service: { fallback: true, pid } satisfies Record_,
      });
      return {};
    },

    async remove() {
      if (!installed()) {
        // The fallback's daemon, or one in a terminal.
        if ((await d.daemonPid()) === undefined) return {};
        const left = await stopDaemon();
        if (left !== undefined) return { running: left };
        updateInstallFile(installFile(), { service: {} });
        return { stopped: true };
      }
      const f = file();
      const { label, unit } = names();
      if (manager === "launchd")
        await d.exec("launchctl", ["bootout", `${domain}/${label}`]);
      else await systemctl("disable", "--now", unit);
      rmSync(f, { force: true });
      if (manager === "systemd") await systemctl("daemon-reload");
      // `--purge` next refuses while the daemon still answers.
      const left = await quiet();
      if (left !== undefined) return { unit: manager, running: left };
      updateInstallFile(installFile(), { service: {} });
      return { unit: manager };
    },

    cli() {
      const argv = [d.execPath, installCli(home(), d.source())];
      // The harness entries run this argv, with or without a service
      // (--no-service): argv() reads it back.
      updateInstallFile(installFile(), { cli: argv });
      return argv;
    },

    argv() {
      // What install last wrote into the entries, not the service's node
      // (stale after --no-service) nor the node running this command.
      const r = readInstallFile(installFile()).cli;
      return Array.isArray(r) &&
        r.length === 2 &&
        r.every((x) => typeof x === "string")
        ? (r as string[])
        : [d.execPath, entryOf()];
    },

    env() {
      const e = installed() ? record().env : undefined;
      return typeof e === "object" && e !== null ? e : {};
    },

    problems() {
      if (!installed()) return [];
      const out: ServiceProblem[] = [];
      const node = record().node;
      if (typeof node === "string" && !existsSync(node))
        out.push({ kind: "node-missing", node });
      if (
        manager === "systemd" &&
        !existsSync(join(d.lingerDir ?? "/var/lib/systemd/linger", d.user))
      )
        out.push({ kind: "linger-off" });
      return out;
    },
  };
}
