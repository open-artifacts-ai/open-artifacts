import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

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
    const v = readlinkSync(binPath(home)).split("/").filter(Boolean).pop();
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
    rest = JSON.parse(readFileSync(stateFile(home), "utf8"));
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
  mustBeSafe(home);
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
 * folder of the same version is replaced.
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

/**
 * Removes every folder under `versions/` except the ones named in `keep`, and
 * the staging leftovers of other processes. Never touches a kept name.
 */
export function prune(
  home: string,
  keep: (string | undefined)[],
  alive: (pid: number) => boolean = pidAlive,
): string[] {
  const dir = versionsDir(home);
  if (unsafeDir(dir) !== undefined || !lstat(dir)) return [];
  const keepSet = new Set(keep.filter((k): k is string => k !== undefined));
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (keepSet.has(name)) continue;
    const m = /^\.(stage|old)\.(\d+)$/.exec(name);
    if (m && alive(Number(m[2]))) continue;
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
  prune(home, [version, previous]);
}

/**
 * One step back: `bin` to the kept previous. The version stepped back from is
 * not kept (exactly one previous). Returns the version now current, or
 * undefined when there is no previous folder to return to.
 */
export function stepBack(home: string): string | undefined {
  const state = readState(home);
  const prev = state.previous;
  if (prev === undefined || !lstat(versionDir(home, prev))) return undefined;
  swap(home, prev);
  writeState(home, { armed: state.armed, current: prev });
  prune(home, [prev]);
  return prev;
}
