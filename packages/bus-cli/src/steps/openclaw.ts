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
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterDeps } from "./adapters.ts";
import { HABITS_MARKER_TEXT, pluginHash } from "./hermes.ts";
import { writeAtomic } from "./skill.ts";

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
/** The slowest step is `plugins install`; the CLI's default 10 s kill is too short for it. */
const OPENCLAW_TIMEOUT_MS = 180_000;

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
 * The state dir the `openclaw` CLI would use: OPENCLAW_STATE_DIR, else the
 * profile's (OPENCLAW_PROFILE: <home>/.openclaw-<name>), else <home>/.openclaw,
 * or a legacy <home>/.clawdbot when only that exists. `--profile` is a flag
 * install cannot see.
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
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (profile)
    return join(
      h,
      `.openclaw${profile.toLowerCase() === "default" ? "" : `-${profile}`}`,
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

/** A folder that carries our plugin's manifest id: ours even when the marker is gone. */
const hasOurManifest = (dir: string): boolean => {
  try {
    const m: unknown = JSON.parse(
      readFileSync(join(dir, "openclaw.plugin.json"), "utf8"),
    );
    return (m as { id?: unknown } | null)?.id === OPENCLAW_PLUGIN_ID;
  } catch {
    return false;
  }
};

/**
 * Whether `dir` is our folder, and whether it matches the shipped plugin.
 * `plugins install --force` replaces the folder, marker included, so a folder
 * with our manifest id and no marker (an install cut short) is ours and stale.
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
    return hasOurManifest(dir) ? "stale" : "foreign";
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
    return await deps.exec("openclaw", args, {
      env: openclawEnv(deps.home, deps.env ?? {}),
      timeoutMs: OPENCLAW_TIMEOUT_MS,
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
  const r = await exec(deps, [
    "plugins",
    "inspect",
    OPENCLAW_PLUGIN_ID,
    "--runtime",
    "--json",
  ]);
  if (r.code !== 0) return why(r);
  let doc: unknown;
  try {
    const at = r.stdout.indexOf("{");
    doc = JSON.parse(at === -1 ? r.stdout : r.stdout.slice(at));
  } catch {
    return "its output was not JSON";
  }
  const d = doc as {
    plugin?: { enabled?: unknown; status?: unknown; toolNames?: unknown };
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
  if (state !== "current") {
    // The user's yes to the habits lives in the folder `plugins install --force`
    // replaces: remember it, and put it back whether or not the install worked.
    const keepHabits =
      state === "stale" &&
      !optedOut &&
      kind(join(dest, OPENCLAW_HABITS_MARKER)) === "file";
    const r = await exec(deps, [
      "plugins",
      "install",
      ...(state === "absent" ? [] : ["--force"]),
      shipped,
    ]);
    const restore = () => {
      if (keepHabits && kind(dest) === "dir")
        writeAtomic(join(dest, OPENCLAW_HABITS_MARKER), HABITS_MARKER_TEXT);
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
  const state = openclawPluginState(dest, undefined);
  if (state === "absent") return "none";
  if (state === "foreign")
    throw new Error(`${dest} is not Open Artifacts bus's; left it untouched`);
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
