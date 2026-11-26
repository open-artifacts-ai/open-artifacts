// Antigravity (agy, S2): the oa-bus agy plugin. A folder of our own under
// agy's global customization root, ~/.gemini/config/plugins/oa-bus, in agy's
// documented layout: plugin.json (the marker agy looks for), its logo, and
// hooks.json at the plugin root. The fixed files are packages/bus-cli/agy-plugin. Its SessionStart hook runs `oa-bus agy-hello`. The oa_bus
// MCP entry stays in ~/.gemini/config/mcp_config.json (S1b). Ownership is a
// marker file in the folder: a folder without it is the user's and never touched.

import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The plugin's folder name, which agy also keys its on/off switch by. */
export const AGY_PLUGIN_NAME = "oa-bus";
/** Written by install, read by uninstall and doctor: the folder is ours when this is there. */
export const AGY_PLUGIN_MARKER = ".oa-bus-managed";
/** The hook's name in hooks.json. */
export const AGY_HOOK_NAME = "oa-bus";
/** Seconds agy gives the hook (it waits for it before the first turn). */
export const AGY_HOOK_TIMEOUT_S = 15;

const MARKER_TEXT =
  "Made by oa-bus install. oa-bus uninstall removes this folder.\n";

export const agyPluginDir = (home: string) =>
  join(home, ".gemini", "config", "plugins", AGY_PLUGIN_NAME);

/** One POSIX shell word: agy runs a hook's command with `sh -c`. */
const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * The hook command: this bus's argv plus `agy-hello`, and a moved home. agy
 * runs it with `sh -c`, so `$PPID` is the agy process. SessionStart fires for
 * a new conversation only; PreInvocation (before each model call) also covers
 * a resumed one (`agy --conversation`, `-c`). So that a call costs no Node
 * start, the shell says `{}` itself when the conversation agy names in the
 * hook's env is already the one recorded for this agy process AND the
 * watcher its watch file names still runs (agy S3). A watcher that died, even
 * by SIGKILL, so sends the next call to Node, which asks the session to start
 * it again; Node also checks the watcher's start time, which the shell can't.
 */
export function agyHookCommand(busBin: string[], movedHome?: string): string {
  const argv = [...busBin, "agy-hello"].map(sh).join(" ");
  const home =
    movedHome === undefined ? "" : `export OA_BUS_HOME=${sh(movedHome)}; `;
  return (
    `${home}d="\${OA_BUS_HOME:-$HOME/.oa-bus}/antigravity"; ` +
    `if [ -n "$ANTIGRAVITY_CONVERSATION_ID" ] && ` +
    `grep -qF "\\"conversationId\\":\\"$ANTIGRAVITY_CONVERSATION_ID\\"" "$d/$PPID.json" 2>/dev/null && ` +
    `p=$(sed -n 's/^{"pid":\\([0-9][0-9]*\\),.*/\\1/p' "$d/$PPID.watch.json" 2>/dev/null) && ` +
    `[ -n "$p" ] && kill -0 "$p" 2>/dev/null; ` +
    `then echo '{}'; else exec ${argv}; fi`
  );
}

/**
 * The plugin's fixed files the installer ships: the CLI bundle's
 * assets/agy-plugin (next to dist/), else packages/bus-cli/agy-plugin.
 */
export const AGY_PLUGIN_ASSETS: string = (() => {
  const packaged = fileURLToPath(
    new URL("../assets/agy-plugin", import.meta.url),
  );
  if (existsSync(packaged)) return packaged;
  return fileURLToPath(new URL("../../agy-plugin", import.meta.url));
})();
/** The shipped files, by their path in the plugin folder. */
const SHIPPED = ["plugin.json", "logo.svg"];
/** agy S3: the watcher's command line, which the hook tells the session to run. */
export const AGY_WATCH_FILE = "watch-command.txt";

/** One shell word, quoted only when it has to be. */
const word = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : sh(s));

/**
 * agy S3: the one fixed command line that starts the watcher. The session
 * runs it as a background command outside agy's sandbox; it has nothing in
 * it from a message, a peer or the session.
 */
export function agyWatchCommand(busBin: string[], movedHome?: string): string {
  const argv = [...busBin, "agy-watch"];
  if (movedHome !== undefined) argv.push("--home", movedHome);
  return argv.map(word).join(" ");
}

/** The plugin's files, as install writes them: the shipped ones and hooks.json. */
export function agyPluginFiles(
  busBin: string[],
  movedHome?: string,
  assets: string = AGY_PLUGIN_ASSETS,
): Record<string, string> {
  const handler = {
    type: "command",
    command: agyHookCommand(busBin, movedHome),
    timeout: AGY_HOOK_TIMEOUT_S,
  };
  const hooks = {
    [AGY_HOOK_NAME]: { SessionStart: [handler], PreInvocation: [handler] },
  };
  return {
    ...Object.fromEntries(
      SHIPPED.map((f) => [f, readFileSync(join(assets, f), "utf8")]),
    ),
    "hooks.json": `${JSON.stringify(hooks, null, 2)}\n`,
    [AGY_WATCH_FILE]: `${agyWatchCommand(busBin, movedHome)}\n`,
  };
}

const isDir = (p: string) => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};
const present = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const readOr = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

/** Atomic: a temp file in the folder, then a rename. Never through a symlink. */
function put(dir: string, name: string, text: string) {
  const dest = join(dir, name);
  mkdirSync(dirname(dest), { recursive: true });
  try {
    if (lstatSync(dest).isSymbolicLink())
      throw new Error(`${dest} is a symlink; left it untouched`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const tmp = `${dest}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o644, flag: "wx" });
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * `absent`: no folder. `foreign`: a folder that is not ours. `current`: ours,
 * with these files. `stale`: ours, with other files (another bus, an older one).
 */
export type AgyPluginState = "absent" | "foreign" | "current" | "stale";

export function agyPluginState(
  home: string,
  files: Record<string, string> | undefined,
): AgyPluginState {
  const dir = agyPluginDir(home);
  if (!present(dir)) return "absent";
  if (!isDir(dir) || !present(join(dir, AGY_PLUGIN_MARKER))) return "foreign";
  if (files === undefined)
    // The bus's argv unknown: only that the hook runs `agy-hello`.
    return /agy-hello/.test(readOr(join(dir, "hooks.json")) ?? "")
      ? "current"
      : "stale";
  return Object.entries(files).every(
    ([name, text]) => readOr(join(dir, name)) === text,
  )
    ? "current"
    : "stale";
}

/** Writes the plugin; true when a file changed. Throws for a folder not ours. */
export function installAgyPlugin(
  home: string,
  files: Record<string, string>,
): boolean {
  const dir = agyPluginDir(home);
  const state = agyPluginState(home, files);
  if (state === "foreign")
    throw new Error(`${dir} is not oa-bus's; left it untouched`);
  if (state === "current") return false;
  mkdirSync(dir, { recursive: true });
  // The marker first: a half-written folder is still ours to finish or remove.
  if (!present(join(dir, AGY_PLUGIN_MARKER)))
    put(dir, AGY_PLUGIN_MARKER, MARKER_TEXT);
  for (const [name, text] of Object.entries(files))
    if (readOr(join(dir, name)) !== text) put(dir, name, text);
  return true;
}

/**
 * Removes our files and the marker, then the folder once it is empty. A
 * folder without the marker is not ours: false, nothing touched.
 */
export function uninstallAgyPlugin(home: string): boolean {
  const dir = agyPluginDir(home);
  if (agyPluginState(home, undefined) === "absent") return false;
  if (agyPluginState(home, undefined) === "foreign") return false;
  for (const name of [...SHIPPED, "hooks.json", AGY_WATCH_FILE])
    rmSync(join(dir, name), { force: true });
  rmSync(join(dir, AGY_PLUGIN_MARKER), { force: true });
  try {
    rmdirSync(dir);
  } catch {} // the user's own files in it stay, and so does the folder
  return true;
}

/**
 * Read-only, for doctor: the plugin folder is someone else's (install skips
 * it), or agy has it switched off in its config.json (`agy plugin disable`).
 */
export function agyPluginProblem(
  home: string,
): { dir: string; problem: "foreign" | "off" } | undefined {
  const dir = agyPluginDir(home);
  const state = agyPluginState(home, undefined);
  if (state === "foreign") return { dir, problem: "foreign" };
  if (state === "absent") return undefined;
  const text = readOr(join(home, ".gemini", "config", "config.json"));
  if (text === undefined) return undefined;
  try {
    const doc = JSON.parse(text.replace(/^﻿/, "")) as {
      plugins?: Record<string, { enabled?: unknown }>;
    };
    return doc.plugins?.[AGY_PLUGIN_NAME]?.enabled === false
      ? { dir, problem: "off" }
      : undefined;
  } catch {
    return undefined;
  }
}
