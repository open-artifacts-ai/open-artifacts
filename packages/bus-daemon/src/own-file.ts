import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { userInfo } from "node:os";

export type OwnFile =
  | { state: "ok"; text: string; note?: string }
  | { state: "none" }
  | { state: "unsafe"; why: string };

/**
 * Whether `gid` is the user's private group: its /etc/group entry is named
 * `user`, lists no members, and no other /etc/passwd user has it as their
 * primary group. A missing or unreadable file, or no entry, is not private.
 */
export function isPrivateGroup(
  gid: number,
  user: string,
  read: () => string = () => readFileSync("/etc/group", "utf8"),
  readPasswd: () => string = () => readFileSync("/etc/passwd", "utf8"),
): boolean {
  let text: string;
  let passwd: string;
  try {
    text = read();
    passwd = readPasswd();
  } catch {
    return false;
  }
  // A primary group is membership too, though /etc/group does not list it.
  for (const line of passwd.split("\n")) {
    const f = line.split(":");
    if (f[3] === String(gid) && f[0] !== user) return false;
  }
  for (const line of text.split("\n")) {
    const [name, , id, members] = line.split(":");
    if (id === String(gid))
      return name === user && (members ?? "").trim() === "";
  }
  return false;
}

/** The process's own group, and whether it is private. Linux only: macOS `staff` is shared. */
export type GroupCheck = {
  gid: number | undefined;
  isPrivate: (gid: number) => boolean;
};
const ownGroup = (): GroupCheck => ({
  gid: process.getgid?.(),
  isPrivate: (gid) => {
    if (process.platform !== "linux") return false;
    try {
      return isPrivateGroup(gid, userInfo().username);
    } catch {
      return false;
    }
  },
});

/**
 * Reads a small config file only when it is safely ours: one open that never
 * follows a symlink and never blocks (a planted FIFO cannot hang it), then
 * fstat on that same fd, so the file checked is the file read. It must be a
 * regular file, owned by `uid`, and not writable by group or others.
 *
 * `allowGroupWrite` (#1527) relaxes only the group bit, and only when the
 * file's group is the process's own AND the user's private group (so nobody
 * else is in it): such a file is read, with a `note`. A world-writable file,
 * or one in a shared group, is still refused. Only callers whose file cannot
 * widen access take it (not the global allowlist). `group` is injected by tests.
 */
export function readOwnFile(
  file: string,
  uid: number | undefined = process.getuid?.(),
  opts: { allowGroupWrite?: boolean; group?: GroupCheck } = {},
): OwnFile {
  let fd: number;
  try {
    fd = openSync(
      file,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "none" };
    return {
      state: "unsafe",
      why: code === "ELOOP" ? "is a symlink" : `cannot be read (${code})`,
    };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { state: "unsafe", why: "is not a regular file" };
    if (uid !== undefined && st.uid !== uid)
      return { state: "unsafe", why: "belongs to another user" };
    if (opts.allowGroupWrite) {
      if (st.mode & 0o002)
        return { state: "unsafe", why: "is writable by everyone" };
      let note: string | undefined;
      if (st.mode & 0o020) {
        const g = opts.group ?? ownGroup();
        if (st.gid !== g.gid || !g.isPrivate(st.gid))
          return {
            state: "unsafe",
            why: "is writable by a group others share",
          };
        note = "is writable by its group";
      }
      return {
        state: "ok",
        text: readFileSync(fd, "utf8"),
        ...(note ? { note } : {}),
      };
    }
    if (st.mode & 0o022)
      return { state: "unsafe", why: "is writable by others" };
    return { state: "ok", text: readFileSync(fd, "utf8") };
  } catch (e) {
    return {
      state: "unsafe",
      why: `cannot be read (${(e as NodeJS.ErrnoException).code ?? String(e)})`,
    };
  } finally {
    closeSync(fd);
  }
}
