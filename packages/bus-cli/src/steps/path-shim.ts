// `oa-bus` on PATH (#1626). Install writes a small sh script named `oa-bus` in
// a user bin dir that is already on the install process's PATH (~/.local/bin;
// on macOS the first of ~/.local/bin or ~/bin on PATH). No candidate on PATH:
// the shim still goes in ~/.local/bin and we print the line to add; shell
// profiles are never edited.
//
// Ownership: ours is a script carrying SHIM_MARKER, or a symlink pointing into
// the bus home. Anything else named `oa-bus` (a global npm install, the user's
// own script) is left alone. Uninstall removes only ours, and only for the bus
// home the script names. Windows has no sh: no shim.

import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve, sep } from "node:path";

export const SHIM_MARKER = "# oa-bus shim: written by oa-bus install";
const HOME_PREFIX = "# oa-bus home: ";
const NAME = "oa-bus";
const LOCAL_HINT = 'export PATH="$HOME/.local/bin:$PATH"';

export type ShimOpts = {
  userHome: string;
  busHome: string;
  /** "linux", "darwin", "win32", or ctx.platform ("linux x64"). */
  platform: string;
  env: { PATH?: string };
};

const isWindows = (platform: string) => platform.startsWith("win32");
const pathDirs = (p: string | undefined) =>
  (p ?? "")
    .split(delimiter)
    .filter((d) => d !== "")
    .map((d) => resolve(d));

const candidates = (o: ShimOpts) =>
  o.platform.startsWith("darwin")
    ? [join(o.userHome, ".local", "bin"), join(o.userHome, "bin")]
    : [join(o.userHome, ".local", "bin")];

const shQuote = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;

export function shimText(o: {
  argv: string[];
  busHome: string;
  userHome: string;
}): string {
  const moved = resolve(o.busHome) !== resolve(o.userHome, ".oa-bus");
  return [
    "#!/bin/sh",
    SHIM_MARKER,
    `${HOME_PREFIX}${resolve(o.busHome)}`,
    ...(moved
      ? [`OA_BUS_HOME=${shQuote(resolve(o.busHome))}`, "export OA_BUS_HOME"]
      : []),
    `exec ${o.argv.map(shQuote).join(" ")} "$@"`,
    "",
  ].join("\n");
}

type Owner = { ours: false } | { ours: true; home: string | undefined };

/** Who owns `file`: undefined when nothing is there. */
function ownerOf(file: string, busHome: string): Owner | undefined {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch {
    return undefined;
  }
  if (st.isSymbolicLink()) {
    try {
      const to = resolve(dirname(file), readlinkSync(file));
      const home = resolve(busHome);
      return to === home || to.startsWith(`${home}/`)
        ? { ours: true, home }
        : { ours: false };
    } catch {
      return { ours: false };
    }
  }
  if (!st.isFile() || st.size > 4096) return { ours: false };
  try {
    const lines = readFileSync(file, "utf8").split("\n");
    if (lines[1] !== SHIM_MARKER) return { ours: false };
    const h = lines[2]?.startsWith(HOME_PREFIX)
      ? lines[2].slice(HOME_PREFIX.length)
      : undefined;
    return { ours: true, home: h };
  } catch {
    return { ours: false };
  }
}

export type ShimResult =
  | { kind: "installed"; path: string; onPath: boolean; hint?: string }
  | { kind: "foreign"; path: string }
  /** Ours, but it names another bus home: left as it is. */
  | { kind: "other-home"; path: string; home: string }
  | { kind: "skipped" };

const sameHome = (owner: Owner | undefined, busHome: string) =>
  owner?.ours === true &&
  (owner.home === undefined || owner.home === resolve(busHome));

/** `exclusive` create: a stale or planted tmp name is unlinked first, so the mode is ours. */
function writeShim(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, text, { mode: 0o755, flag: "wx" });
    chmodSync(tmp, 0o755);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Writes (or refreshes) our shim; never replaces a file that is not ours, nor
 * our shim of another bus home. Our shim for this home in any other candidate
 * dir is refreshed too, so none keeps a stale argv.
 */
export function installShim(o: ShimOpts & { argv: string[] }): ShimResult {
  if (isWindows(o.platform)) return { kind: "skipped" };
  const onPath = new Set(pathDirs(o.env.PATH));
  const list = candidates(o);
  const dir = list.find((d) => onPath.has(d)) ?? (list[0] as string);
  const path = join(dir, NAME);
  const owner = ownerOf(path, o.busHome);
  if (owner && !owner.ours) return { kind: "foreign", path };
  if (owner?.ours && !sameHome(owner, o.busHome))
    return { kind: "other-home", path, home: owner.home as string };
  mkdirSync(dir, { recursive: true });
  const text = shimText(o);
  writeShim(path, text);
  for (const d of list) {
    const other = join(d, NAME);
    if (d !== dir && sameHome(ownerOf(other, o.busHome), o.busHome))
      writeShim(other, text);
  }
  const on = onPath.has(dir);
  return {
    kind: "installed",
    path,
    onPath: on,
    ...(on ? {} : { hint: LOCAL_HINT }),
  };
}

/** Removes our shim for this bus home from every candidate dir; the path that went, if any. */
export function removeShim(
  o: Omit<ShimOpts, "env"> & { env?: unknown },
): string | undefined {
  if (isWindows(o.platform)) return undefined;
  let removed: string | undefined;
  for (const dir of candidates({ ...o, env: {} })) {
    const file = join(dir, NAME);
    const owner = ownerOf(file, o.busHome);
    if (!owner?.ours) continue;
    if (owner.home !== undefined && owner.home !== resolve(o.busHome)) continue;
    rmSync(file, { force: true });
    removed = file;
  }
  return removed;
}

export type ShimState =
  | { kind: "ours"; path: string }
  | { kind: "other"; path: string }
  | { kind: "off-path"; path: string; hint: string }
  | { kind: "missing" };

const executable = (f: string) => {
  try {
    accessSync(f, constants.X_OK);
    return lstatSync(f).isFile() || lstatSync(f).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Read-only, for doctor: what `oa-bus` resolves to, and whether that is this install. undefined on Windows. */
export function shimState(o: ShimOpts): ShimState | undefined {
  if (isWindows(o.platform)) return undefined;
  // npx puts its cache's node_modules/.bin first, holding the package's own
  // oa-bus: that is not the command a person types.
  const dirs = pathDirs(o.env.PATH).filter(
    (d) => !d.endsWith(`${sep}node_modules${sep}.bin`),
  );
  for (const dir of dirs) {
    const file = join(dir, NAME);
    if (!executable(file)) continue;
    const owner = ownerOf(file, o.busHome);
    return owner?.ours &&
      (owner.home === undefined || owner.home === resolve(o.busHome))
      ? { kind: "ours", path: file }
      : { kind: "other", path: file };
  }
  for (const dir of candidates(o)) {
    const file = join(dir, NAME);
    const owner = ownerOf(file, o.busHome);
    if (
      owner?.ours &&
      (owner.home === undefined || owner.home === resolve(o.busHome))
    )
      return { kind: "off-path", path: file, hint: LOCAL_HINT };
  }
  return { kind: "missing" };
}
