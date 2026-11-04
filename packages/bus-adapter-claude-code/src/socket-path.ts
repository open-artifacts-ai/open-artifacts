import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// The block between the markers is copied byte for byte into the Pi
// extension (assets/oa-bus.ts), which cannot import it; a test keeps them equal.
// <socket-path>
/** sun_path holds 104 bytes on macOS and 108 on Linux, NUL included. */
export const MAX_SOCKET_PATH = process.platform === "linux" ? 107 : 103;

/** unsafeSocketDir's answer for a folder another user owns: only an admin can remove it. */
export const NOT_OURS = "belongs to another user";

/**
 * The canonical home: its deepest existing ancestor through realpath.native
 * (symlinks resolved, and the volume's own case on a case-insensitive one),
 * the same before and after the home exists. Every limit and hash uses it.
 */
export function canonicalHome(p: string): string {
  const rest: string[] = [];
  for (let cur = p; ; cur = dirname(cur)) {
    try {
      return join(realpathSync.native(cur), ...rest);
    } catch {
      if (dirname(cur) === cur) return p;
      rest.unshift(basename(cur));
    }
  }
}

/**
 * Why a socket folder must not be used, or null when it is safe. Another
 * local user could create it first, so it must be ours, a real folder (not a
 * symlink) and 0700. A missing folder is safe: the daemon creates it.
 */
export function unsafeSocketDir(dir: string): string | null {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(dir);
  } catch {
    return null;
  }
  if (st.uid !== process.getuid?.()) return NOT_OURS;
  if (st.isSymbolicLink()) return "is a symlink";
  if (!st.isDirectory()) return "is not a folder";
  if ((st.mode & 0o777) !== 0o700)
    return `is open to other users (mode ${(st.mode & 0o777).toString(8)})`;
  return null;
}

/**
 * Where the short folder goes. On Linux, /run/user/<uid> (from getuid, never
 * $XDG_RUNTIME_DIR) when it is ours and 0700: no other user can create in it
 * and nothing ages it out. Otherwise /tmp, never $TMPDIR: a launchd daemon and
 * an MCP server started from a terminal see different TMPDIRs.
 */
export function socketBase(
  platform: string = process.platform,
  runDir = `/run/user/${process.getuid?.() ?? 0}`,
): string {
  if (platform !== "linux") return "/tmp";
  try {
    if (lstatSync(runDir).isDirectory() && !unsafeSocketDir(runDir))
      return runDir;
  } catch {}
  return "/tmp";
}

/** The short per-user folder for sockets that would not fit under `home`. */
export function shortSocketDir(home: string): string {
  const hash = createHash("sha256").update(canonicalHome(home)).digest("hex");
  return join(
    socketBase(),
    `oa-bus-${process.getuid?.() ?? 0}-${hash.slice(0, 8)}`,
  );
}

const fits = (p: string) => Buffer.byteLength(p) <= MAX_SOCKET_PATH;

/** Where the daemon listens: `<home>/daemon.sock`, unless that is too long for a unix socket. */
export function daemonSocketPath(home: string): string {
  const plain = join(canonicalHome(home), "daemon.sock");
  return fits(plain) ? plain : join(shortSocketDir(home), "daemon.sock");
}

/** Claude's return sockets (`<8 hex>.sock`): under the home, or the short folder when they would not fit. */
export function claudeReturnDir(home: string): string {
  const dir = join(canonicalHome(home), "claude-return");
  return fits(join(dir, "00000000.sock"))
    ? dir
    : join(shortSocketDir(home), "claude-return");
}

/** Whether the daemon socket or the Claude return sockets live in the short folder. */
export function shortDirInUse(home: string): boolean {
  const dir = shortSocketDir(home);
  return [daemonSocketPath(home), claudeReturnDir(home)].some((p) =>
    p.startsWith(`${dir}/`),
  );
}

/** Why the daemon socket for `home` must not be dialed or bound, or null. */
export function socketDirProblem(home: string): string | null {
  const dir = shortSocketDir(home);
  if (dirname(daemonSocketPath(home)) !== dir) return null;
  const why = unsafeSocketDir(dir);
  return why && `${dir} ${why}`;
}
// </socket-path>

/**
 * Creates socket folder `dir` (0700, never recursive, never a chmod that
 * could follow a symlink), or checks the one already there. Null when it is
 * safe to bind in; else why not. Run before every bind in the short folder.
 */
export function ensureSocketDir(dir: string): string | null {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST")
      return `cannot be created (${e instanceof Error ? e.message : String(e)})`;
  }
  return unsafeSocketDir(dir);
}
