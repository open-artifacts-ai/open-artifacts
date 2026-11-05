import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConfigFile } from "@oa/bus-ipc";
import { BusConfigSchema, CONFIG_FILE } from "@oa/bus-protocol";
import { globalFile, readGlobalDirs } from "./global.ts";
import { type GroupCheck, type OwnFile, readOwnFile } from "./own-file.ts";

export type { ConfigFile };

/** POSIX single quotes: nothing inside is expanded; a quote becomes '\\''. */
export const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/** The exact step that clears `why` for `file`. The path is quoted: it may come from a clone. */
function fixFor(file: string, why: string): string {
  const q = shq(file);
  if (why === "is writable by everyone") return `run chmod o-w ${q}`;
  if (why === "is writable by others") return `run chmod go-w ${q}`;
  if (why === "is writable by a group others share")
    return `run chmod g-w ${q}`;
  if (why === "belongs to another user")
    return `remove it (rm ${q}) or take it over (chown "$USER" ${q})`;
  if (why === "is a symlink" || why === "is not a regular file")
    return `remove it (rm ${q}), then save a regular file there`;
  if (why.startsWith("cannot be read")) return `run chmod u+r ${q}`;
  return `fix or remove ${q}`;
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
      fix: `edit ${shq(file)} to valid JSON, or remove it`,
    };
  if (own.state === "ok" && own.note)
    return {
      file,
      state: "noted",
      reason: own.note,
      fix: `optional: run chmod g-w ${shq(file)}`,
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
  group?: GroupCheck,
): ConfigFile | undefined {
  const own = readOwnFile(file, uid, {
    allowGroupWrite: true,
    ...(group ? { group } : {}),
  });
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
        ? `remove it (rm ${shq(file)}), then run oa-bus global add <dir> again`
        : fixFor(file, error),
  };
}

/**
 * The `.oa-bus.json` files that were refused or noted, kept by path. A
 * namespace read records what it saw; `list` re-reads each, so a fixed file
 * drops off.
 */
export class ConfigIssues {
  #files = new Map<
    string,
    { uid: number | undefined; group?: GroupCheck | undefined }
  >();

  /** Records the result of reading `file` (undefined: it is fine now). */
  set(
    file: string,
    uid: number | undefined,
    issue: ConfigFile | undefined,
    group?: GroupCheck,
  ) {
    if (issue) this.#files.set(file, { uid, group });
    else this.#files.delete(file);
  }

  /** Every tracked file, re-read now; `within` keeps only those at these paths. */
  list(within?: ReadonlySet<string>): ConfigFile[] {
    const out: ConfigFile[] = [];
    for (const [file, { uid, group }] of [...this.#files]) {
      if (within && !within.has(file)) continue;
      const issue = inspectConfig(file, uid, group);
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
  opts: { uid?: number; globalFile?: string; group?: GroupCheck } = {},
): ConfigFile[] {
  const uid = opts.uid ?? process.getuid?.();
  const out: ConfigFile[] = [];
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {}
  for (const file of configPaths(real)) {
    const issue = inspectConfig(file, uid, opts.group);
    if (issue) out.push(issue);
  }
  const g = inspectGlobal(opts.globalFile);
  if (g) out.push(g);
  return out;
}

/**
 * Every `.oa-bus.json` path the daemon reads for a session in `cwd` (a
 * realpath), nearest first. One walker for the daemon and doctor.
 */
export function configPaths(cwd: string): string[] {
  const out: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    out.push(join(dir, CONFIG_FILE));
    if (dirname(dir) === dir) return out;
  }
}
