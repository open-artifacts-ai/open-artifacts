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
import { join, resolve } from "node:path";
import type { AdapterDeps } from "./adapters.ts";

/** The plugin's name in plugin.yaml, and its folder under plugins/. */
export const HERMES_PLUGIN_NAME = "oa-bus";
/** Written by install, read by uninstall and status: the folder is ours when this is there. */
export const HERMES_MARKER = ".oa-bus-managed";

type Env = Record<string, string | undefined>;

/** HERMES_HOME as Hermes reads it (hermes_constants.py), else `~/.hermes`. */
export function hermesHome(home: string, env: Env): string {
  const v = env.HERMES_HOME?.trim();
  if (!v) return join(home, ".hermes");
  if (v === "~") return home;
  return resolve(v.startsWith("~/") ? join(home, v.slice(2)) : v);
}

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

const exec = async (deps: Pick<AdapterDeps, "exec">, args: string[]) => {
  try {
    return await deps.exec("hermes", args);
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
    // Beside the destination so the rename stays on one filesystem.
    const tmp = join(
      plugins,
      `.${HERMES_PLUGIN_NAME}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
    );
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
    }
  }
  // --no-allow-tool-override: without it Hermes asks on a terminal. Our tools
  // are new names; the plugin never replaces a built-in.
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
  }
  rmSync(dest, { recursive: true, force: true });
  return "done";
}

/**
 * Whether Hermes lists the plugin as enabled, from `hermes plugins list --json`
 * (never config.yaml). False when it cannot be told.
 */
export async function hermesEnabled(
  deps: Pick<AdapterDeps, "exec">,
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
