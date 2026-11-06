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
  renameSync,
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
/** Where a copy is built before it moves into plugins/, in the Hermes home. */
export const HERMES_STAGING = ".oa-bus-staging";

type Env = Record<string, string | undefined>;

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
export function hermesHome(home: string, env: Env): string {
  const native = join(home, ".hermes");
  const v = env.HERMES_HOME?.trim();
  const given = v ? tilded(home, v) : undefined;
  if (given !== undefined && basename(dirname(given)) === "profiles")
    return given;
  const base = given ?? native;
  const root = (() => {
    if (given === undefined) return native;
    const rel = relative(native, given);
    // Under ~/.hermes: that is the root, whatever the folder is called.
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
      return native;
    return given;
  })();
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

/** The env Hermes's CLI runs with, so it and our files agree on the home. */
export const hermesEnv = (home: string, env: Env) => ({
  HERMES_HOME: hermesHome(home, env),
});

export const hermesPluginDir = (home: string, env: Env) =>
  join(hermesHome(home, env), "plugins", HERMES_PLUGIN_NAME);

const kind = (path: string): "dir" | "file" | "link" | undefined => {
  try {
    const st = lstatSync(path);
    return st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file";
  } catch {
    return undefined;
  }
};

/** Package files only: no bytecode caches, no marker, no hidden files. */
function files(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel)).sort()) {
    if (name === "__pycache__" || name.startsWith(".") || name.endsWith(".pyc"))
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
    const plugins = join(dest, "..");
    mkdirSync(plugins, { recursive: true });
    // Staged outside plugins/ (Hermes loads any folder there with a plugin.yaml),
    // but in the same Hermes home, so the rename stays on one filesystem. A
    // killed install leaves its stage behind: the next install sweeps them.
    const staging = join(plugins, "..", HERMES_STAGING);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const tmp = join(staging, randomBytes(4).toString("hex"));
    try {
      mkdirSync(tmp);
      for (const f of files(shipped)) {
        mkdirSync(join(tmp, f, ".."), { recursive: true });
        cpSync(join(shipped, f), join(tmp, f));
      }
      writeFileSync(
        join(tmp, HERMES_MARKER),
        `managed by the Open Artifacts bus installer: edits are replaced on reinstall. ${pluginHash(shipped)}\n`,
      );
      if (state === "stale") rmSync(dest, { recursive: true, force: true });
      renameSync(tmp, dest);
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      throw e;
    } finally {
      rmSync(staging, { recursive: true, force: true });
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
