import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BusConfigSchema, CONFIG_FILE } from "@oa/bus-protocol";
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

/** The file's content; empty when it is missing, unreadable or not safely ours. */
export function readFolders(h: string = home()): Folders {
  const none: Folders = { map: {}, no: {}, seen: {} };
  const own = readOwnFile(foldersFile(h));
  if (own.state !== "ok") return none;
  try {
    const raw = JSON.parse(own.text) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return none;
    const map = strMap(raw.map);
    const no = strMap(raw.no);
    const seen = strMap(raw.seen);
    return map && no && seen ? { map, no, seen } : none;
  } catch {
    return none;
  }
}

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
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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

const noted = new Set<string>();

/**
 * The line the daemon says once per folder for a session that has no
 * instance yet, or undefined (already said, or the folder is mapped).
 * Slice S3 calls this; it writes nothing.
 */
export function unmappedFolderNote(
  cwd: string,
  h: string = home(),
): string | undefined {
  if (!("unmapped" in folderHomeLookup(h)(cwd))) return undefined;
  const key = `${h}\0${folderKey(cwd)}`;
  if (noted.has(key)) return undefined;
  noted.add(key);
  return "This folder isn't tied to an instance yet. Run oa-bus use here.";
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
