import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConfigFile } from "@oa/bus-ipc";
import { BusConfigSchema, CONFIG_FILE } from "@oa/bus-protocol";
import { globalFile, readGlobalDirs } from "./global.ts";
import { type OwnFile, readOwnFile } from "./own-file.ts";

export type { ConfigFile };

/** The exact step that clears `why` for `file`. */
function fixFor(file: string, why: string): string {
  if (why === "is writable by everyone") return `run chmod o-w ${file}`;
  if (why === "is writable by others") return `run chmod go-w ${file}`;
  if (why === "belongs to another user")
    return `remove it (rm ${file}) or take it over (chown "$USER" ${file})`;
  if (why === "is a symlink" || why === "is not a regular file")
    return `remove it (rm ${file}), then save a regular file there`;
  if (why.startsWith("cannot be read")) return `run chmod u+r ${file}`;
  return `fix or remove ${file}`;
}

/** One `.oa-bus.json` the daemon read: refused, noted, or fine (undefined). */
export function configIssue(
  file: string,
  own: OwnFile,
  valid = true,
): ConfigFile | undefined {
  if (own.state === "unsafe")
    return {
      file,
      state: "refused",
      reason: own.why,
      fix: fixFor(file, own.why),
    };
  if (own.state === "ok" && !valid)
    return {
      file,
      state: "refused",
      reason: "is not a valid .oa-bus.json",
      fix: `edit ${file} to valid JSON, or remove it`,
    };
  if (own.state === "ok" && own.note)
    return {
      file,
      state: "noted",
      reason: own.note,
      fix: `optional: run chmod g-w ${file}`,
    };
  return undefined;
}

/** Whether `text` is a `.oa-bus.json` the daemon would use. */
export function isValidConfig(text: string): boolean {
  try {
    return BusConfigSchema.safeParse(JSON.parse(text)).success;
  } catch {
    return false;
  }
}

/** Reads `file` as the daemon reads a `.oa-bus.json`. */
export function inspectConfig(
  file: string,
  uid: number | undefined,
): ConfigFile | undefined {
  const own = readOwnFile(file, uid, { allowGroupWrite: true });
  return configIssue(file, own, own.state !== "ok" || isValidConfig(own.text));
}

/** The allowlist, read as the daemon reads it (strict: group-writable is refused). */
export function inspectGlobal(file = globalFile()): ConfigFile | undefined {
  const { error } = readGlobalDirs(file);
  if (error === undefined) return undefined;
  return {
    file,
    state: "refused",
    reason: error,
    fix:
      error === "is not valid JSON"
        ? `remove it (rm ${file}), then run oa-bus global add <dir> again`
        : fixFor(file, error),
  };
}

/**
 * The `.oa-bus.json` files that were refused or noted, kept by path. A
 * namespace read records what it saw; `list` re-reads each, so a fixed file
 * drops off.
 */
export class ConfigIssues {
  #files = new Map<string, number | undefined>();

  /** Records the result of reading `file` (undefined: it is fine now). */
  set(file: string, uid: number | undefined, issue: ConfigFile | undefined) {
    if (issue) this.#files.set(file, uid);
    else this.#files.delete(file);
  }

  list(): ConfigFile[] {
    const out: ConfigFile[] = [];
    for (const [file, uid] of [...this.#files]) {
      const issue = inspectConfig(file, uid);
      if (issue) out.push(issue);
      else this.#files.delete(file);
    }
    return out;
  }
}

/**
 * Every refused or noted config file that applies at `cwd`: each
 * `.oa-bus.json` from the real cwd up, then the allowlist. For `doctor`,
 * which reads without a daemon.
 */
export function scanConfigFiles(
  cwd: string,
  opts: { uid?: number; globalFile?: string } = {},
): ConfigFile[] {
  const uid = opts.uid ?? process.getuid?.();
  const out: ConfigFile[] = [];
  let dir: string;
  try {
    dir = realpathSync(cwd);
  } catch {
    dir = cwd;
  }
  for (; ; dir = dirname(dir)) {
    const issue = inspectConfig(join(dir, CONFIG_FILE), uid);
    if (issue) out.push(issue);
    if (dirname(dir) === dir) break;
  }
  const g = inspectGlobal(opts.globalFile);
  if (g) out.push(g);
  return out;
}
