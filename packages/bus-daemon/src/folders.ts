import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BUS_CMD, BusConfigSchema, CONFIG_FILE } from "@oa/bus-protocol";
import { home } from "./config.ts";
import {
  canonicalAddress,
  type HomeLookup,
  type Instance,
  listInstances,
  MAIN_INSTANCE,
} from "./instances.ts";
import { writePrivate } from "./namespaces.ts";
import { readOwnFile } from "./own-file.ts";

/**
 * Which instance each folder uses (#2793), `<home>/folders.json`:
 * `{"map": {"/real/path": "name"}, "no": {...}, "seen": {...}}`.
 * `map` names an instance by its local name, never by address. `no` is the
 * suggestion the user turned down for a folder; `seen` the last suggestion
 * shown for it. Keys are real paths, at the git repo root inside a repo.
 */
export const foldersFile = (h: string = home()): string =>
  join(h, "folders.json");

export type Folders = {
  map: Record<string, string>;
  no: Record<string, string>;
  seen: Record<string, string>;
};

const strMap = (v: unknown): Record<string, string> | undefined => {
  if (v === undefined) return {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== "string" || !isAbsolute(k)) return undefined;
    out[k] = x;
  }
  return out;
};

/**
 * The file's content, and `unusable` when the file is there but cannot be
 * trusted or parsed (so a writer leaves it alone instead of dropping it).
 */
export function inspectFolders(h: string = home()): {
  folders: Folders;
  unusable: boolean;
} {
  const none: Folders = { map: {}, no: {}, seen: {} };
  const own = readOwnFile(foldersFile(h));
  if (own.state === "none") return { folders: none, unusable: false };
  if (own.state !== "ok") return { folders: none, unusable: true };
  try {
    const raw = JSON.parse(own.text) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return { folders: none, unusable: true };
    const map = strMap(raw.map);
    const no = strMap(raw.no);
    const seen = strMap(raw.seen);
    return map && no && seen
      ? { folders: { map, no, seen }, unusable: false }
      : { folders: none, unusable: true };
  } catch {
    return { folders: none, unusable: true };
  }
}

/** The file's content; empty when it is missing, unreadable or not safely ours. */
export const readFolders = (h: string = home()): Folders =>
  inspectFolders(h).folders;

/** Writes folders.json, 0600, atomically. Only a command the user ran calls this. */
export function writeFolders(f: Folders, h: string = home()): void {
  writePrivate(h, "folders.json", f);
}

const git = (cwd: string): string | null => {
  try {
    return (
      execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
};

/** The key of a folder: its real path, at the git repo root inside a repo. */
export function folderKey(
  cwd: string,
  gitRoot: (dir: string) => string | null = git,
): string {
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    real = resolve(cwd);
  }
  const root = gitRoot(real);
  if (root) {
    try {
      const r = realpathSync(root);
      if (inside(r, real)) return r;
    } catch {}
  }
  return real;
}

/** Whether `path` is `dir` or below it. */
function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/** The map entry that covers `real` (longest prefix wins), or undefined. */
export function coveringEntry(
  f: Folders,
  real: string,
): { dir: string; name: string } | undefined {
  let best: { dir: string; name: string } | undefined;
  for (const [dir, name] of Object.entries(f.map))
    if (inside(dir, real) && (!best || dir.length > best.dir.length))
      best = { dir, name };
  return best;
}

/**
 * Where a folder's agents connect. With only main set up every folder is
 * main, and nothing is read or written. With several instances a mapped
 * folder covers everything below it (longest prefix wins); an unmapped one,
 * or one naming an instance that is gone, is unmapped: no guess.
 */
export function folderHomeLookup(h: string = home()): HomeLookup {
  return (cwd) => {
    const list = listInstances(h);
    if (list.length === 1 && list[0]?.main) return { instance: MAIN_INSTANCE };
    let real: string;
    try {
      real = realpathSync(cwd);
    } catch {
      real = resolve(cwd);
    }
    const hit = coveringEntry(readFolders(h), real);
    if (hit && list.some((i) => i.name === hit.name))
      return { instance: hit.name };
    return { unmapped: true };
  };
}

/** Bound on the once-only sets, so a long-lived daemon does not grow them without end. */
const SEEN_MAX = 1000;
const noted = new Set<string>();

/**
 * The line the daemon says once per folder for a session that has no
 * instance yet, or undefined (already said, or the folder is mapped).
 * The daemon calls this for a session that starts in an unmapped folder; it
 * writes nothing.
 */
export function unmappedFolderNote(
  cwd: string,
  h: string = home(),
  /** The folder's key, when the caller already has it (it runs git). */
  known?: string,
): string | undefined {
  if (!("unmapped" in folderHomeLookup(h)(cwd))) return undefined;
  const key = `${h}\0${known ?? folderKey(cwd)}`;
  if (noted.has(key)) return undefined;
  if (noted.size >= SEEN_MAX) noted.clear();
  noted.add(key);
  return `This folder isn't tied to an instance yet. Run ${BUS_CMD} use in this folder.`;
}

/**
 * The instance a repo suggests: the nearest `.oa-bus.json` that sets one,
 * read from the same places and with the same owner and permission checks as
 * the namespace file. A file that does not parse is refused whole. With
 * `below`, a file deeper than that folder is ignored. Returns the canonical
 * address (a non-ASCII host in its xn-- form), never a local name.
 */
export function readSuggestion(
  cwd: string,
  opts: { below?: string; uid?: number } = {},
): string | undefined {
  let dir: string;
  try {
    dir = realpathSync(cwd);
  } catch {
    return undefined;
  }
  const uid = opts.uid ?? process.getuid?.();
  for (let d = dir; ; d = dirname(d)) {
    const deeper = opts.below !== undefined && !inside(d, opts.below);
    if (!deeper) {
      const own = readOwnFile(join(d, CONFIG_FILE), uid, {
        allowGroupWrite: true,
      });
      if (own.state === "ok") {
        try {
          const parsed = BusConfigSchema.safeParse(JSON.parse(own.text));
          if (parsed.success && parsed.data.instance !== undefined)
            return canonicalAddress(parsed.data.instance);
        } catch {}
      }
    }
    if (dirname(d) === d) return undefined;
  }
}

/** The added instance at exactly this canonical address; never matched by name. */
export function instanceAt(
  address: string,
  list: Instance[],
): Instance | undefined {
  return list.find((i) => canonicalAddress(i.hub) === address);
}

const suggested = new Set<string>();
const ADDRESS_SHOWN_MAX = 120;

/**
 * The line the daemon says once per folder and suggestion when the repo
 * suggests an instance that differs from what the folder last saw, after the
 * folder was already answered (yes or no). It never moves the session and
 * writes nothing: `use` is what records the new suggestion. The address is
 * the canonical (ASCII, xn--) form.
 */
export function changedSuggestionNote(
  cwd: string,
  h: string = home(),
  /** The folder's key, when the caller already has it (it runs git). */
  known?: string,
): string | undefined {
  const { folders: f, unusable } = inspectFolders(h);
  if (unusable) return undefined;
  const key = known ?? folderKey(cwd);
  const covering = coveringEntry(f, key);
  if (covering === undefined && f.no[key] === undefined) return undefined;
  const found = readSuggestion(cwd, covering ? { below: covering.dir } : {});
  if (found === undefined || found === f.seen[key]) return undefined;
  // Characters a terminal could act on are never shown.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips controls
  const shown = found.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "");
  if (shown !== found || shown.length > ADDRESS_SHOWN_MAX) return undefined;
  const once = `${h}\0${key}\0${found}`;
  if (suggested.has(once)) return undefined;
  if (suggested.size >= SEEN_MAX) suggested.clear();
  suggested.add(once);
  return `This repo now suggests ${shown}. Nothing changed: this folder keeps its answer.`;
}
