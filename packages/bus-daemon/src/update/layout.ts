import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * The install layout under a bus home (#2552):
 *
 *   <home>/versions/<v>/   one folder per version, owner-only
 *   <home>/bin             a symlink to versions/<v>: the only path the
 *                          service and harness entries use
 *   <home>/update.json     0600: { armed, current, previous }
 *
 * Switching is one rename(2) of a new symlink over `bin`, so there is no
 * moment without a `bin`. Exactly one previous version is kept.
 */

export type UpdateState = {
  /** Set only by a hand-run install. */
  armed: boolean;
  current?: string;
  previous?: string;
};

/** A folder name that cannot leave `versions/`: no slash, no leading dot. */
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
export const isSafeVersion = (v: unknown): v is string =>
  typeof v === "string" && SAFE_VERSION.test(v);

export const versionsDir = (home: string) => join(home, "versions");
export const versionDir = (home: string, v: string) =>
  join(versionsDir(home), v);
export const binPath = (home: string) => join(home, "bin");
export const stateFile = (home: string) => join(home, "update.json");

const lstat = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};

/**
 * Why `path` may not hold code the service runs, or undefined when it may:
 * a real folder (never a symlink), ours, and not writable by group or world.
 * A missing path is not checked here. No uid on Windows: the mode is skipped too.
 */
export function unsafeDir(path: string): string | undefined {
  const st = lstat(path);
  if (!st) return undefined;
  if (!st.isDirectory() || st.isSymbolicLink())
    return `${path} is not a folder`;
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  if (st.uid !== uid) return `${path} belongs to another user`;
  if ((st.mode & 0o022) !== 0) return `${path} is writable by others`;
  return undefined;
}

function mustBeSafe(path: string): void {
  const why = unsafeDir(path);
  if (why) throw new Error(`refusing to use it: ${why}`);
}

/** The version `bin` points at; undefined for a missing bin or a real folder. */
export function currentVersion(home: string): string | undefined {
  try {
    const link = readlinkSync(binPath(home));
    // Exactly what swap writes. A Windows junction reads back absolute.
    const v =
      process.platform === "win32"
        ? link.split(/[\\/]/).filter(Boolean).pop()
        : /^versions\/([^/]+)$/.exec(link)?.[1];
    return isSafeVersion(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function readState(home: string): UpdateState {
  try {
    const j = JSON.parse(readFileSync(stateFile(home), "utf8")) as Record<
      string,
      unknown
    >;
    return {
      armed: j.armed === true,
      ...(isSafeVersion(j.current) ? { current: j.current } : {}),
      ...(isSafeVersion(j.previous) ? { previous: j.previous } : {}),
    };
  } catch {
    return { armed: false };
  }
}

/** Temp file and rename, 0600. Keys this PR does not know are kept. */
export function writeState(home: string, state: UpdateState): void {
  let rest: Record<string, unknown> = {};
  try {
    const old: unknown = JSON.parse(readFileSync(stateFile(home), "utf8"));
    // Only a plain object is worth keeping; an array or null is dropped.
    if (old !== null && typeof old === "object" && !Array.isArray(old))
      rest = old as Record<string, unknown>;
  } catch {
    // none yet
  }
  const next: Record<string, unknown> = { ...rest, armed: state.armed };
  for (const k of ["current", "previous"] as const)
    if (state[k] === undefined) delete next[k];
    else next[k] = state[k];
  const tmp = `${stateFile(home)}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, stateFile(home));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Creates `versions/` owner-only and refuses one that is not. */
export function ensureVersions(home: string): void {
  mkdirSync(versionsDir(home), { recursive: true, mode: 0o700 });
  if (!lstat(versionsDir(home))?.isSymbolicLink())
    chmodSync(versionsDir(home), 0o700);
  // A home that is a link (a folder moved to another disk) is allowed: the
  // checks run on what it points at.
  mustBeSafe(realpathSync(home));
  mustBeSafe(versionsDir(home));
}

/**
 * Moves a real `bin/` folder (the layout before #2552) to `versions/<its
 * version>`, `unknown-<ts>` when its package.json cannot say. Returns that
 * version, or undefined when `bin` is not a real folder. Run with the service
 * stopped: a folder cannot be renamed over by a symlink, so `bin` is briefly
 * missing until `swap`.
 */
export function migrate(
  home: string,
  now: () => number = Date.now,
): string | undefined {
  const bin = binPath(home);
  const st = lstat(bin);
  if (!st?.isDirectory() || st.isSymbolicLink()) return undefined;
  let v: string | undefined;
  try {
    const j = JSON.parse(readFileSync(join(bin, "package.json"), "utf8"));
    if (isSafeVersion(j?.version)) v = j.version;
  } catch {
    // unreadable
  }
  v ??= `unknown-${now()}`;
  ensureVersions(home);
  // A folder of that version already there is a stale copy: the legacy one is what ran.
  if (lstat(versionDir(home, v)))
    rmSync(versionDir(home, v), { recursive: true, force: true });
  renameSync(bin, versionDir(home, v));
  chmodSync(versionDir(home, v), 0o700);
  return v;
}

/**
 * Builds `versions/<version>` with `fill(dir)` in a private staging folder
 * beside it, then renames it into place (same filesystem, so atomic). A
 * folder of the same version is replaced: when `bin` points at it, `bin`
 * has no target for the moment between the two renames. Install runs with the
 * service stopped; the updater never replaces the running version.
 */
export function stage(
  home: string,
  version: string,
  fill: (dir: string) => void,
): string {
  if (!isSafeVersion(version)) throw new Error("not a version");
  ensureVersions(home);
  const dest = versionDir(home, version);
  const tmp = join(versionsDir(home), `.stage.${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { mode: 0o700 });
  try {
    fill(tmp);
    chmodSync(tmp, 0o700);
    mustBeSafe(tmp);
    if (lstat(dest)) {
      const old = join(versionsDir(home), `.old.${process.pid}`);
      rmSync(old, { recursive: true, force: true });
      renameSync(dest, old);
      renameSync(tmp, dest);
      rmSync(old, { recursive: true, force: true });
    } else renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return dest;
}

/**
 * Points `bin` at `versions/<version>`: a symlink `bin.<pid>.new` renamed
 * over `bin`, so a reader sees the old or the new, never none. Windows cannot
 * rename over a folder or junction: there it is remove then rename.
 */
export function swap(home: string, version: string): void {
  if (!isSafeVersion(version)) throw new Error("not a version");
  const target = versionDir(home, version);
  // Never leave bin dangling: the target is a real folder, and a safe one.
  if (!lstat(target)?.isDirectory()) throw new Error("no such version folder");
  mustBeSafe(target);
  const bin = binPath(home);
  const tmp = `${bin}.${process.pid}.new`;
  rmSync(tmp, { recursive: true, force: true });
  try {
    // Relative, so a moved home still resolves.
    symlinkSync(
      join("versions", version),
      tmp,
      process.platform === "win32" ? "junction" : undefined,
    );
    if (process.platform === "win32")
      rmSync(bin, { recursive: true, force: true });
    renameSync(tmp, bin);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

export type PruneOptions = {
  alive?: (pid: number) => boolean;
};

/** `versions/<v>/.live/<pid>`: a process running from that version. */
const liveDir = (versionPath: string) => join(versionPath, ".live");

/**
 * Whether a live process runs from `versionPath`: a `.live/<pid>` marker
 * whose pid is alive. A `.live` that cannot be read counts as in use.
 */
export function inUse(
  versionPath: string,
  alive: (pid: number) => boolean = pidAlive,
): boolean {
  const dir = liveDir(versionPath);
  const st = lstat(dir);
  if (!st) return false;
  // Never followed: a link or a file where the folder belongs is unreadable.
  if (!st.isDirectory()) return true;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return true;
  }
  let live = false;
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const f = join(dir, n);
    const k = lstat(f);
    if (k?.isSymbolicLink()) rmSync(f, { force: true });
    else if (!k?.isFile()) continue;
    else if (alive(Number(n))) live = true;
    // A dead pid's marker is stale: drop it.
    else rmSync(f, { force: true });
  }
  return live;
}

/** The folder names `markLive` accepts: x.y.z, or a legacy unknown-<ts>. */
const MARKABLE = /^(?:\d+\.\d+\.\d+|unknown-\d+)$/;

/**
 * Called at startup by the daemon and every adapter/CLI process: when the
 * running bundle's real path is under the real `<home>/versions/<v>/`, writes
 * `versions/<v>/.live/<pid>` (0600) and removes it on exit. Only that home:
 * any other `versions` folder (an nvm install) is left alone. Best effort:
 * never throws. Returns the marker path, or undefined.
 */
export function markLive(
  entryFile: string,
  home: string,
  pid: number = process.pid,
): string | undefined {
  try {
    const root = realpathSync(versionsDir(home));
    const rel = relative(root, realpathSync(entryFile)).split(sep);
    const v = rel[0];
    if (rel.length < 2 || v === undefined || v === ".." || !MARKABLE.test(v))
      return undefined;
    const vdir = join(root, v);
    mkdirSync(liveDir(vdir), { recursive: true, mode: 0o700 });
    const marker = join(liveDir(vdir), String(pid));
    writeFileSync(marker, "", { mode: 0o600 });
    process.once("exit", () => rmSync(marker, { force: true }));
    return marker;
  } catch {
    return undefined;
  }
}

/**
 * Removes every folder under `versions/` except the ones named in `keep`, and
 * the staging leftovers of other processes. A folder some live process runs
 * from (see `markLive`) stays for the next prune. Never touches a kept name.
 * Returns the names removed.
 */
export function prune(
  home: string,
  keep: (string | undefined)[],
  opts: PruneOptions = {},
): string[] {
  const alive = opts.alive ?? pidAlive;
  const dir = versionsDir(home);
  if (unsafeDir(dir) !== undefined || !lstat(dir)) return [];
  const keepSet = new Set(keep.filter((k): k is string => k !== undefined));
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (keepSet.has(name)) continue;
    const st = lstat(join(dir, name));
    if (!st) continue;
    // A stray link is unlinked, never followed; a stray file is left alone.
    if (st.isSymbolicLink()) {
      rmSync(join(dir, name), { force: true });
      removed.push(name);
      continue;
    }
    if (!st.isDirectory()) continue;
    const m = /^\.(stage|old)\.(\d+)$/.exec(name);
    if (m ? alive(Number(m[2])) : inUse(join(dir, name), alive)) continue;
    rmSync(join(dir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Puts `fill`'s folder in as the current version: migrate a real `bin/`,
 * stage, swap, record, prune to current and one previous. Reinstalling the
 * running version keeps its previous. `armed` is set: only a hand-run install
 * calls this.
 */
export function installVersion(
  home: string,
  version: string,
  fill: (dir: string) => void,
  opts: PruneOptions = {},
): void {
  ensureVersions(home);
  const was = migrate(home) ?? currentVersion(home);
  stage(home, version, fill);
  swap(home, version);
  const prior = readState(home);
  const previous = was !== undefined && was !== version ? was : prior.previous;
  writeState(home, {
    armed: true,
    current: version,
    ...(previous !== undefined && previous !== version ? { previous } : {}),
  });
  prune(home, [version, previous], opts);
}

/**
 * One step back: `bin` to the kept previous. The version stepped back from is
 * not kept (exactly one previous). Returns the version now current, or
 * undefined when there is no previous folder to return to.
 */
export function stepBack(
  home: string,
  opts: PruneOptions = {},
): string | undefined {
  const state = readState(home);
  const prev = state.previous;
  if (prev === undefined || !lstat(versionDir(home, prev))) return undefined;
  swap(home, prev);
  writeState(home, { armed: state.armed, current: prev });
  prune(home, [prev], opts);
  return prev;
}
