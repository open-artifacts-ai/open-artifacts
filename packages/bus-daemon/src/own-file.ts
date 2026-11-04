import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";

export type OwnFile =
  | { state: "ok"; text: string }
  | { state: "none" }
  | { state: "unsafe"; why: string };

/**
 * Reads a small config file only when it is safely ours: one open that never
 * follows a symlink and never blocks (a planted FIFO cannot hang it), then
 * fstat on that same fd, so the file checked is the file read. It must be a
 * regular file, owned by `uid`, and not writable by group or others.
 */
export function readOwnFile(
  file: string,
  uid: number | undefined = process.getuid?.(),
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
