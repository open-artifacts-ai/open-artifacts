// OpenClaw: the bus is a native plugin (`oa-bus`), not an MCP server. Install
// ships the built plugin folder with the CLI and has OpenClaw's own CLI install
// and enable it (`plugins install <dir>`, `plugins enable oa-bus`), so OpenClaw
// writes its own config and install record: nothing here edits openclaw.json or
// reads anything else in the state dir. Ownership is a marker file we add to
// the installed folder, <state dir>/extensions/oa-bus, after OpenClaw copies it.

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterDeps } from "./adapters.ts";
import { HABITS_MARKER_TEXT, pluginHash } from "./hermes.ts";
import { writeAtomic } from "./skill.ts";
import { readInstallFile, updateInstallFile } from "./step.ts";

/** The plugin's id in openclaw.plugin.json, and its folder under extensions/. */
export const OPENCLAW_PLUGIN_ID = "oa-bus";
/** Written after install, read by uninstall, status and habits: the folder is ours when it is there. */
export const OPENCLAW_MARKER = ".oa-bus-managed";
/**
 * Present in the plugin folder only when the user said yes to the always-on
 * habits: the plugin adds them to a turn only while it exists. It is not a
 * package file, so it never counts toward the hash.
 */
export const OPENCLAW_HABITS_MARKER = "habits.on";
/** What install says when OPENCLAW_NIX_MODE=1 (plugin commands are off there). */
export const OPENCLAW_NIX =
  "OpenClaw is in Nix mode (OPENCLAW_NIX_MODE=1), which turns off plugin commands; left it alone";
/** The note uninstall leaves when the folder went with no `openclaw` to uninstall it. */
export const OPENCLAW_NO_CLI =
  "no openclaw binary found; its config may still list oa-bus";
/** The note when the folder is gone and OpenClaw's own uninstall could not clear the config entry. */
export const OPENCLAW_STRAY_NOTE = (reason: string): string =>
  `Couldn't remove oa-bus from OpenClaw's config: its plugin folder is gone, and \`openclaw plugins uninstall oa-bus\` failed (${reason}). Run that command yourself to finish.`;
/** The CLI's default 10 s kill is too short for OpenClaw: install is the slow one. */
const INSTALL_TIMEOUT_MS = 180_000;
const ENABLE_TIMEOUT_MS = 60_000;
const INSPECT_TIMEOUT_MS = 30_000;

type Env = Record<string, string | undefined>;

const placeholder = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return !t || t === "undefined" || t === "null" ? undefined : t;
};

/**
 * OpenClaw's home, as its resolveRequiredHomeDir does for the CLI: OPENCLAW_HOME
 * (a leading `~` is the user's home), else the user's home. Mirrors
 * packages/bus-adapter-openclaw/src/state-dir.ts, which a test compares.
 */
export function openclawHome(home: string, env: Env): string {
  const explicit = placeholder(env.OPENCLAW_HOME);
  return resolve(explicit ? explicit.replace(/^~(?=$|[\\/])/, home) : home);
}

/**
 * The state dir the `openclaw` CLI would use: OPENCLAW_STATE_DIR, else
 * <home>/.openclaw, or a legacy <home>/.clawdbot when only that exists.
 * OPENCLAW_PROFILE is ignored, as OpenClaw's resolveStateDir ignores it: only
 * the `--profile` flag sets OPENCLAW_STATE_DIR, and install cannot see a flag.
 */
export function openclawStateDir(home: string, env: Env): string {
  const h = openclawHome(home, env);
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override)
    return resolve(
      override.startsWith("~")
        ? override.replace(/^~(?=$|[\\/])/, h)
        : override,
    );
  const next = join(h, ".openclaw");
  if (env.OPENCLAW_TEST_FAST === "1" || existsSync(next)) return next;
  const legacy = join(h, ".clawdbot");
  return existsSync(legacy) ? legacy : next;
}

export const openclawPluginDir = (home: string, env: Env): string =>
  join(openclawStateDir(home, env), "extensions", OPENCLAW_PLUGIN_ID);

/**
 * Every plugin folder of this OpenClaw install: the default state dir's, each
 * profile's (`<home>/.openclaw-<name>`), and the active one, which an
 * OPENCLAW_STATE_DIR keeps outside all of those. Turning habits off sweeps all.
 */
export function openclawPluginDirs(home: string, env: Env): string[] {
  const h = openclawHome(home, env);
  const states = [join(h, ".openclaw"), join(h, ".clawdbot")];
  try {
    for (const name of readdirSync(h).sort())
      if (name.startsWith(".openclaw-")) states.push(join(h, name));
  } catch {}
  const out = states.map((s) => join(s, "extensions", OPENCLAW_PLUGIN_ID));
  const active = openclawPluginDir(home, env);
  if (!out.includes(active)) out.push(active);
  return out;
}

/** The env OpenClaw's CLI runs with, so it and our files agree on the state dir. */
export const openclawEnv = (home: string, env: Env) => ({
  OPENCLAW_STATE_DIR: openclawStateDir(home, env),
});

/** Plugin commands are off under Nix. */
export const openclawNix = (env: Env | undefined): boolean =>
  env?.OPENCLAW_NIX_MODE === "1";

const kind = (path: string): "dir" | "file" | "link" | undefined => {
  try {
    const st = lstatSync(path);
    return st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file";
  } catch {
    return undefined;
  }
};

/** Whether the folder's manifest names our plugin: enough to delete habits.on there, never to replace it. */
export const openclawManifestIsOurs = (dir: string): boolean => {
  try {
    const m: unknown = JSON.parse(
      readFileSync(join(dir, "openclaw.plugin.json"), "utf8"),
    );
    return (m as { id?: unknown } | null)?.id === OPENCLAW_PLUGIN_ID;
  } catch {
    return false;
  }
};

/** Whether `dir` holds exactly the shipped package files (a manifest id alone proves nothing). */
const sameAsShipped = (dir: string, shipped: string | undefined): boolean => {
  if (shipped === undefined) return false;
  try {
    return pluginHash(dir) === pluginHash(shipped);
  } catch {
    return false;
  }
};

/**
 * Whether `dir` is our folder, and whether it matches the shipped plugin.
 * `plugins install --force` replaces the folder, marker included. A folder
 * without our marker is ours only when its files are exactly the shipped ones
 * (an install cut short): a fork that shares the manifest id is foreign.
 */
export function openclawPluginState(
  dir: string,
  shipped: string | undefined,
): "absent" | "foreign" | "stale" | "current" {
  const k = kind(dir);
  if (k === undefined) return "absent";
  if (k !== "dir") return "foreign";
  let marker: string;
  try {
    marker = readFileSync(join(dir, OPENCLAW_MARKER), "utf8").trim();
  } catch {
    return sameAsShipped(dir, shipped) ? "stale" : "foreign";
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

/**
 * Install notes in <bus home>/install.json which state dir it put the plugin in.
 * Uninstall runs OpenClaw's own uninstall for a folder that is gone only when
 * this says we installed it, so a user who never did sees nothing.
 */
const installFile = (deps: Pick<AdapterDeps, "home" | "busHome">): string =>
  join(deps.busHome ?? join(deps.home, ".oa-bus"), "install.json");
const recordedStateDir = (deps: AdapterDeps): string | undefined => {
  const r = readInstallFile(installFile(deps)).openclaw;
  const d = (r as { stateDir?: unknown } | null)?.stateDir;
  return typeof d === "string" ? d : undefined;
};
const forgetInstall = (deps: AdapterDeps) => {
  if (recordedStateDir(deps) !== undefined)
    updateInstallFile(installFile(deps), { openclaw: {} });
};

const exec = async (
  deps: Pick<AdapterDeps, "exec" | "home" | "env">,
  args: string[],
  timeoutMs = ENABLE_TIMEOUT_MS,
) => {
  try {
    return await deps.exec("openclaw", args, {
      env: openclawEnv(deps.home, deps.env ?? {}),
      timeoutMs,
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
const why = (r: { code: number; stdout: string; stderr: string }) =>
  firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`;

const realOrSelf = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** The tools and hook the plugin must show at runtime for the install to count. */
const NEED_TOOLS = ["oabus_self", "oabus_send_message", "oabus_fetch"];
const NEED_HOOK = "before_prompt_build";

/**
 * `plugins inspect oa-bus --runtime --json`: loaded, enabled, with its tools
 * and its prompt hook registered. Returns the first thing wrong, or undefined.
 */
export async function openclawVerify(
  deps: Pick<AdapterDeps, "exec" | "home" | "env">,
): Promise<string | undefined> {
  const r = await exec(
    deps,
    ["plugins", "inspect", OPENCLAW_PLUGIN_ID, "--runtime", "--json"],
    INSPECT_TIMEOUT_MS,
  );
  if (r.code !== 0) return why(r);
  let doc: unknown;
  try {
    const at = r.stdout.indexOf("{");
    doc = JSON.parse(at === -1 ? r.stdout : r.stdout.slice(at));
  } catch {
    return "its output was not JSON";
  }
  const d = doc as {
    plugin?: {
      enabled?: unknown;
      status?: unknown;
      toolNames?: unknown;
      rootDir?: unknown;
    };
    typedHooks?: { name?: unknown }[];
  };
  if (d.plugin?.enabled !== true) return "the plugin is not enabled";
  if (d.plugin.status !== "loaded")
    return `the plugin is ${typeof d.plugin.status === "string" ? d.plugin.status : "not loaded"}, not loaded`;
  const tools = Array.isArray(d.plugin.toolNames) ? d.plugin.toolNames : [];
  const missing = NEED_TOOLS.filter((t) => !tools.includes(t));
  if (missing.length > 0)
    return `its tools are not registered (${missing.join(", ")})`;
  if (!d.typedHooks?.some((h) => h.name === NEED_HOOK))
    return `its ${NEED_HOOK} hook is not registered`;
  // A linked dev copy can override ours: habits.on would then do nothing.
  const dest = openclawPluginDir(deps.home, deps.env ?? {});
  const root = d.plugin.rootDir;
  if (typeof root !== "string")
    return "it did not say which folder the plugin loads from";
  if (realOrSelf(root) !== realOrSelf(dest))
    return `a different copy loads from ${root}, not ${dest}`;
  return undefined;
}

/**
 * Installs the shipped plugin and enables it. A folder that is not ours is
 * never replaced. `optedOut` is the user's recorded "no" to the habits: the
 * habits marker is carried across the reinstall only without it.
 */
export async function installOpenclaw(
  deps: AdapterDeps,
  notes: string[],
  optedOut: boolean,
): Promise<"done" | "absent"> {
  if (!deps.which("openclaw")) return "absent";
  if (openclawNix(deps.env)) {
    notes.push(OPENCLAW_NIX);
    return "absent";
  }
  const shipped = deps.assets.openclaw;
  if (
    shipped === undefined ||
    !existsSync(join(shipped, "openclaw.plugin.json"))
  )
    throw new Error("the OpenClaw plugin is missing from this install");
  const dest = openclawPluginDir(deps.home, deps.env ?? {});
  const state = openclawPluginState(dest, shipped);
  if (state === "foreign")
    throw new Error(
      `${dest} exists and is not Open Artifacts bus's; left it untouched`,
    );
  const habitsFile = join(dest, OPENCLAW_HABITS_MARKER);
  // The user's "no" wins on every install, a current one included.
  const dropHabitsIfOptedOut = () => {
    if (optedOut && kind(dest) === "dir") rmSync(habitsFile, { force: true });
  };
  if (state === "current") {
    dropHabitsIfOptedOut();
    // Nothing to install; nothing to enable if it already loads.
    if ((await openclawVerify(deps)) === undefined) return "done";
  } else {
    // The user's yes to the habits lives in the folder `plugins install --force`
    // replaces: remember it, and put it back whether or not the install worked.
    const keepHabits =
      state === "stale" && !optedOut && kind(habitsFile) === "file";
    const r = await exec(
      deps,
      [
        "plugins",
        "install",
        ...(state === "absent" ? [] : ["--force"]),
        shipped,
      ],
      INSTALL_TIMEOUT_MS,
    );
    // Only into a folder that carries our marker: an install cut short after the
    // swap leaves a bare one, and the yes is lost rather than put where off could
    // not vouch for it.
    const restore = () => {
      if (
        keepHabits &&
        kind(dest) === "dir" &&
        kind(join(dest, OPENCLAW_MARKER)) === "file"
      )
        writeAtomic(habitsFile, HABITS_MARKER_TEXT);
    };
    if (r.code !== 0) {
      restore();
      throw new Error(`\`openclaw plugins install\` failed (${why(r)})`);
    }
    if (kind(dest) !== "dir")
      throw new Error(
        `\`openclaw plugins install\` finished, but ${dest} is not there`,
      );
    writeAtomic(
      join(dest, OPENCLAW_MARKER),
      `managed by the Open Artifacts bus installer: edits are replaced on reinstall. ${pluginHash(shipped)}\n`,
    );
    updateInstallFile(installFile(deps), {
      openclaw: { stateDir: openclawStateDir(deps.home, deps.env ?? {}) },
    });
    // A habits.on in the shipped folder is not the user's yes.
    rmSync(habitsFile, { force: true });
    restore();
  }
  const en = await exec(deps, ["plugins", "enable", OPENCLAW_PLUGIN_ID]);
  if (en.code !== 0)
    throw new Error(
      `installed the plugin in ${dest}, but \`openclaw plugins enable ${OPENCLAW_PLUGIN_ID}\` failed (${why(en)})`,
    );
  const bad = await openclawVerify(deps);
  if (bad !== undefined)
    throw new Error(
      `installed and enabled the plugin, but \`openclaw plugins inspect ${OPENCLAW_PLUGIN_ID} --runtime\` says ${bad}`,
    );
  return "done";
}

/** Uninstalls the plugin through OpenClaw, then removes any folder left. Anything not ours stays. */
export async function uninstallOpenclaw(
  deps: AdapterDeps,
  notes: string[],
): Promise<"done" | "none"> {
  const dest = openclawPluginDir(deps.home, deps.env ?? {});
  const state = openclawPluginState(dest, deps.assets.openclaw);
  if (state === "foreign")
    throw new Error(`${dest} is not Open Artifacts bus's; left it untouched`);
  if (state === "absent") {
    // The folder may have been deleted by hand, leaving OpenClaw's config entry
    // behind. OpenClaw's own uninstall clears an orphaned record; we never edit
    // its config. Nothing to keep here, so a failure is a note, not an error.
    // Only when our install record says we put the plugin in this state dir.
    if (
      recordedStateDir(deps) !== openclawStateDir(deps.home, deps.env ?? {}) ||
      openclawNix(deps.env) ||
      !deps.which("openclaw")
    )
      return "none";
    const r = await exec(deps, [
      "plugins",
      "uninstall",
      "--force",
      OPENCLAW_PLUGIN_ID,
    ]);
    if (r.code === 0) {
      forgetInstall(deps);
      return "done";
    }
    notes.push(OPENCLAW_STRAY_NOTE(why(r)));
    return "none";
  }
  if (openclawNix(deps.env)) {
    notes.push(OPENCLAW_NIX);
    return "none";
  }
  if (deps.which("openclaw")) {
    // --force: without a terminal the command refuses to ask.
    const r = await exec(deps, [
      "plugins",
      "uninstall",
      "--force",
      OPENCLAW_PLUGIN_ID,
    ]);
    if (r.code !== 0)
      throw new Error(
        `\`openclaw plugins uninstall ${OPENCLAW_PLUGIN_ID}\` failed (${why(r)}); left the plugin folder, rerun once OpenClaw works`,
      );
  } else notes.push(OPENCLAW_NO_CLI);
  rmSync(dest, { recursive: true, force: true });
  forgetInstall(deps);
  return "done";
}

/**
 * The built plugin folder the installer ships: the CLI bundle's assets/openclaw
 * (next to dist/), else the adapter package's own build in a source checkout.
 */
export const OPENCLAW_PLUGIN: string = (() => {
  const packaged = fileURLToPath(
    new URL("../assets/openclaw", import.meta.url),
  );
  if (existsSync(packaged)) return packaged;
  return fileURLToPath(
    new URL("../../../bus-adapter-openclaw/dist", import.meta.url),
  );
})();
