// Hermes Agent: the bus is a Python plugin, not an MCP server. Install copies
// the plugin folder to <hermes home>/plugins/oa-bus and has Hermes's own CLI
// enable it; nothing else in the Hermes home is read or written (never
// config.yaml, SOUL.md, .env). Ownership is a marker file inside the folder.

import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { AdapterDeps } from "./adapters.ts";

/** The plugin's name in plugin.yaml, and its folder under plugins/. */
export const HERMES_PLUGIN_NAME = "oa-bus";
/** Written by install, read by uninstall and status: the folder is ours when this is there. */
export const HERMES_MARKER = ".oa-bus-managed";
/** The note uninstall leaves when the folder went with no `hermes` to disable it. */
export const HERMES_NO_CLI =
  "no hermes binary found; its config may still list oa-bus";
/**
 * Present in the plugin folder only when the user said yes to the always-on
 * habits (#1602): the plugin adds them to a turn only while it exists. It is
 * not a package file, so it never counts toward the hash, and a reinstall keeps it.
 */
export const HERMES_HABITS_MARKER = "habits.on";
/** Where a copy is built before it moves into plugins/, in the Hermes home. */
export const HERMES_STAGING = ".oa-bus-staging";

type Env = Record<string, string | undefined>;

/** What the marker holds; only its presence matters. */
export const HABITS_MARKER_TEXT =
  "The Open Artifacts bus habits are on for this plugin. Remove: oa-bus install --no-habits\n";

/**
 * Python's non-strict Path.resolve(): the deepest existing ancestor is
 * realpath'd and the missing rest is appended, so a symlinked ~/.hermes still
 * counts for a HERMES_HOME that is not there yet.
 */
const real = (p: string): string => {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return p;
      rest.push(basename(cur));
      cur = up;
    }
  }
};

/** A staged copy older than this is abandoned, whatever its pid says (pid reuse, other hosts). */
export const STAGING_STALE_MS = 10 * 60 * 1000;
const STAGE_NAME = /^(\d+)-[0-9a-f]+$/;

/** Whether a process exists: EPERM means it does, ESRCH that it does not. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes staged copies a killed install left, and only those: an entry is
 * stale when its pid is dead or it is older than STAGING_STALE_MS; a name not
 * ours is swept only when old. A live peer's fresh entry, and `own`, stay.
 */
export function sweepStaging(
  staging: string,
  own: string,
  o: { now?: number; alive?: (pid: number) => boolean } = {},
): void {
  const now = o.now ?? Date.now();
  const alive = o.alive ?? pidAlive;
  let names: string[];
  try {
    names = readdirSync(staging);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === own) continue;
    const path = join(staging, name);
    let old: boolean;
    try {
      old = now - lstatSync(path).mtimeMs > STAGING_STALE_MS;
    } catch {
      continue;
    }
    const m = STAGE_NAME.exec(name);
    // A pid from another container or pid namespace can read as dead or alive;
    // the age rule covers the alive case.
    if (m ? old || !alive(Number(m[1])) : old) {
      try {
        // Removes a symlink entry itself, never its target.
        rmSync(path, { recursive: true, force: true });
      } catch {} // a peer's entry we cannot remove must not abort the install
    }
  }
}

/**
 * Hermes's platform default home (hermes_constants.py
 * _platform_default_hermes_home): %LOCALAPPDATA%\hermes on Windows, falling
 * back to <home>\AppData\Local\hermes when it is unset or blank; ~/.hermes
 * everywhere else. HERMES_DATA_DIR_SUFFIX is not mirrored.
 */
const nativeHome = (home: string, env: Env, platform: NodeJS.Platform) => {
  if (platform !== "win32") return join(home, ".hermes");
  const local = env.LOCALAPPDATA?.trim();
  return join(local || join(home, "AppData", "Local"), "hermes");
};

const tilded = (home: string, v: string) =>
  v === "~" ? home : resolve(v.startsWith("~/") ? join(home, v.slice(2)) : v);

/**
 * The Hermes home its CLI would run in, mirrored from Hermes's source:
 * hermes_cli/main.py (the profile is picked before anything else loads) and
 * hermes_constants.py get_default_hermes_root. A HERMES_HOME already inside
 * `profiles/` is used as is; otherwise `<root>/active_profile`, when it names a
 * profile that exists, selects `<root>/profiles/<name>`. A supervised s6 child
 * ignores active_profile. Only that one file is read (a profile name).
 */
export function hermesHome(
  home: string,
  env: Env,
  platform: NodeJS.Platform = process.platform,
): string {
  const native = nativeHome(home, env, platform);
  const v = env.HERMES_HOME?.trim();
  const given = v ? tilded(home, v) : undefined;
  if (given !== undefined && basename(dirname(given)) === "profiles")
    return given;
  const base = given ?? native;
  const root = hermesRoot(home, env, platform);
  if (env.HERMES_S6_SUPERVISED_CHILD) return base;
  try {
    const name = readFileSync(join(root, "active_profile"), "utf8")
      .trim()
      .toLowerCase();
    if (name && name !== "default" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
      const dir = join(root, "profiles", name);
      if (lstatSync(dir).isDirectory()) return dir;
    }
  } catch {}
  return base;
}

/**
 * The root all profiles live under (`<root>/profiles/<name>`), by the same
 * rules as hermesHome: a HERMES_HOME inside `profiles/` has its grandparent
 * as root; one under ~/.hermes means ~/.hermes; any other is its own root.
 */
export function hermesRoot(
  home: string,
  env: Env,
  platform: NodeJS.Platform = process.platform,
): string {
  const native = nativeHome(home, env, platform);
  const v = env.HERMES_HOME?.trim();
  const given = v ? tilded(home, v) : undefined;
  if (given === undefined) return native;
  if (basename(dirname(given)) === "profiles") return dirname(dirname(given));
  // Hermes resolves both sides (Path.resolve) for this check only.
  const rel = relative(real(native), real(given));
  // Under ~/.hermes: that is the root, whatever the folder is called.
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return native;
  return given;
}

/** What reading `<root>/profiles` did: the profile names, and a note when the user should hear of it. */
export function hermesProfilesScan(
  home: string,
  env: Env,
  platform: NodeJS.Platform = process.platform,
): { names: string[]; note?: string; incomplete: boolean } {
  const path = join(hermesRoot(home, env, platform), "profiles");
  // An lstat that fails reads as "not a link"; readdirSync's error decides the note.
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {}
  const target = () => {
    try {
      return realpathSync(path);
    } catch {
      try {
        return resolve(dirname(path), readlinkSync(path));
      } catch {
        return "somewhere else";
      }
    }
  };
  try {
    const names = readdirSync(path).sort();
    return {
      names,
      incomplete: false,
      note: isLink
        ? `The Hermes profiles folder ${path} is a symlink to ${target()}. Its profiles were checked too.`
        : undefined,
    };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "error";
    if (code === "ENOENT")
      return {
        names: [],
        incomplete: false,
        note: isLink
          ? `The Hermes profiles folder ${path} is a symlink to ${target()}, which doesn't exist, so there were no profiles to check.`
          : undefined,
      };
    if (code === "ENOTDIR")
      return {
        names: [],
        incomplete: false,
        note: `The Hermes profiles folder ${path} isn't a folder, so there were no profiles to check.`,
      };
    return {
      names: [],
      incomplete: true,
      note: `Couldn't read the Hermes profiles folder ${path} (${code}), so habits may still be on in a profile there.`,
    };
  }
}

/**
 * Every plugin folder of this Hermes: the root's own, each profile's, and the
 * active one, which a HERMES_HOME under ~/.hermes keeps outside both.
 */
export function hermesPluginDirs(
  home: string,
  env: Env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const root = hermesRoot(home, env, platform);
  const out = [join(root, "plugins", HERMES_PLUGIN_NAME)];
  for (const name of hermesProfilesScan(home, env, platform).names)
    out.push(join(root, "profiles", name, "plugins", HERMES_PLUGIN_NAME));
  const active = hermesPluginDir(home, env, platform);
  if (!out.includes(active)) out.push(active);
  return out;
}

/** The env Hermes's CLI runs with, so it and our files agree on the home. */
export const hermesEnv = (
  home: string,
  env: Env,
  platform: NodeJS.Platform = process.platform,
) => ({
  HERMES_HOME: hermesHome(home, env, platform),
});

export const hermesPluginDir = (
  home: string,
  env: Env,
  platform: NodeJS.Platform = process.platform,
) => join(hermesHome(home, env, platform), "plugins", HERMES_PLUGIN_NAME);

const kind = (path: string): "dir" | "file" | "link" | undefined => {
  try {
    const st = lstatSync(path);
    return st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file";
  } catch {
    return undefined;
  }
};

/** Package files only: no bytecode caches, no marker, no habits marker, no hidden files. */
function files(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel)).sort()) {
    if (
      name === "__pycache__" ||
      name.startsWith(".") ||
      name.endsWith(".pyc") ||
      (rel === "" && name === HERMES_HABITS_MARKER)
    )
      continue;
    const r = rel ? `${rel}/${name}` : name;
    if (kind(join(dir, r)) === "dir") out.push(...files(dir, r));
    else out.push(r);
  }
  return out;
}

/** A hash of the package files' names and bytes. */
export function pluginHash(dir: string): string {
  const h = createHash("sha256");
  for (const f of files(dir)) {
    h.update(`${f}\0`);
    h.update(readFileSync(join(dir, f)));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

/** Whether `dir` is our folder, and whether it matches the shipped plugin. */
export function pluginState(
  dir: string,
  shipped: string | undefined,
): "absent" | "foreign" | "stale" | "current" {
  const k = kind(dir);
  if (k === undefined) return "absent";
  if (k !== "dir") return "foreign";
  let marker: string;
  try {
    marker = readFileSync(join(dir, HERMES_MARKER), "utf8").trim();
  } catch {
    return "foreign";
  }
  if (!marker.startsWith("managed by the Open Artifacts bus installer"))
    return "foreign";
  if (shipped === undefined) return "stale";
  try {
    return marker.endsWith(` ${pluginHash(shipped)}`) &&
      pluginHash(dir) === pluginHash(shipped)
      ? "current"
      : "stale";
  } catch {
    return "stale";
  }
}

const exec = async (
  deps: Pick<AdapterDeps, "exec" | "home" | "env">,
  args: string[],
) => {
  try {
    return await deps.exec("hermes", args, {
      env: hermesEnv(deps.home, deps.env ?? {}),
    });
  } catch (e) {
    return {
      code: -1,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
    };
  }
};
const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

/**
 * Copies the shipped plugin into place and enables it. A folder that is not
 * ours is never replaced. Returns whether the folder was (re)written.
 */
export async function installHermes(
  deps: AdapterDeps,
): Promise<"done" | "absent"> {
  if (!deps.which("hermes")) return "absent";
  const shipped = deps.assets.hermes;
  if (shipped === undefined)
    throw new Error("the Hermes plugin is missing from this install");
  const dest = hermesPluginDir(deps.home, deps.env ?? {});
  const state = pluginState(dest, shipped);
  if (state === "foreign")
    throw new Error(
      `${dest} exists and is not Open Artifacts bus's; left it untouched`,
    );
  if (state !== "current") {
    // The user's yes to the habits lives in the folder being replaced: carry it over.
    const keepHabits =
      state === "stale" && kind(join(dest, HERMES_HABITS_MARKER)) === "file";
    const plugins = join(dest, "..");
    mkdirSync(plugins, { recursive: true });
    // Staged outside plugins/ (Hermes loads any folder there with a plugin.yaml),
    // but in the same Hermes home, so the rename stays on one filesystem. A
    // killed install leaves its stage behind: the next install sweeps them.
    const staging = join(plugins, "..", HERMES_STAGING);
    const own = `${process.pid}-${randomBytes(4).toString("hex")}`;
    // A symlink or file here would make the sweep touch somewhere else.
    const st = lstatSync(staging, { throwIfNoEntry: false });
    if (st !== undefined && !st.isDirectory())
      throw new Error(
        `${staging} is not a plain folder; remove it and run the install again`,
      );
    mkdirSync(staging, { recursive: true });
    sweepStaging(staging, own, deps.staging);
    const tmp = join(staging, own);
    try {
      // recursive: a peer's rmdir may remove the empty staging folder after our mkdir above.
      mkdirSync(tmp, { recursive: true });
      for (const f of files(shipped)) {
        mkdirSync(join(tmp, f, ".."), { recursive: true });
        cpSync(join(shipped, f), join(tmp, f));
      }
      writeFileSync(
        join(tmp, HERMES_MARKER),
        `managed by the Open Artifacts bus installer: edits are replaced on reinstall. ${pluginHash(shipped)}\n`,
      );
      if (keepHabits)
        writeFileSync(join(tmp, HERMES_HABITS_MARKER), HABITS_MARKER_TEXT);
      if (state === "stale") rmSync(dest, { recursive: true, force: true });
      renameSync(tmp, dest);
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    } finally {
      // Only the folder itself, and only when no peer is staging in it.
      try {
        rmdirSync(staging);
      } catch {}
    }
  }
  // Enable only a plugin Hermes does not list as enabled, so a reinstall never
  // rewrites the tool-override grant the user may have given it.
  if (await hermesEnabled(deps)) return "done";
  // --no-allow-tool-override: without it Hermes asks on a terminal. Our tools
  // are new names; the plugin never replaces a built-in, so a first install
  // rightly records no grant.
  const r = await exec(deps, [
    "plugins",
    "enable",
    "--no-allow-tool-override",
    HERMES_PLUGIN_NAME,
  ]);
  if (r.code !== 0)
    throw new Error(
      `copied the plugin to ${dest}, but \`hermes plugins enable ${HERMES_PLUGIN_NAME}\` failed (${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`})`,
    );
  return "done";
}

/** Disables the plugin, then removes our folder. Anything not ours stays. */
export async function uninstallHermes(
  deps: AdapterDeps,
  notes: string[],
): Promise<"done" | "none"> {
  const dest = hermesPluginDir(deps.home, deps.env ?? {});
  const state = pluginState(dest, undefined);
  if (state === "absent") return "none";
  if (state === "foreign")
    throw new Error(`${dest} is not Open Artifacts bus's; left it untouched`);
  // Before the folder goes: Hermes refuses to disable a plugin it cannot find.
  if (deps.which("hermes")) {
    const r = await exec(deps, ["plugins", "disable", HERMES_PLUGIN_NAME]);
    if (r.code !== 0)
      throw new Error(
        `\`hermes plugins disable ${HERMES_PLUGIN_NAME}\` failed (${firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`}); left the plugin folder, rerun once Hermes works`,
      );
  } else notes.push(HERMES_NO_CLI);
  rmSync(dest, { recursive: true, force: true });
  return "done";
}

/**
 * Whether Hermes lists the plugin as enabled, from `hermes plugins list --json`
 * (never config.yaml). False when it cannot be told.
 */
export async function hermesEnabled(
  deps: Pick<AdapterDeps, "exec" | "home" | "env">,
): Promise<boolean> {
  const r = await exec(deps, ["plugins", "list", "--json", "--user"]);
  if (r.code !== 0) return false;
  try {
    const list: unknown = JSON.parse(r.stdout);
    return (
      Array.isArray(list) &&
      list.some(
        (e) =>
          typeof e === "object" &&
          e !== null &&
          (e as { name?: unknown }).name === HERMES_PLUGIN_NAME &&
          (e as { status?: unknown }).status === "enabled",
      )
    );
  } catch {
    return false;
  }
}
