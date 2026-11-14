import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type Ctx, say, tilde } from "../context.ts";

const TAIL = 50;

/**
 * The logs folder when it is safe to read from: a real folder (never a link),
 * owned by this user, closed to group and others, and the same folder (dev and
 * ino) when opened by descriptor. Otherwise a reason.
 */
const checkDir = (
  dir: string,
): { ok: true; dev: number; ino: number } | { ok: false; why: string } => {
  let fd: number | undefined;
  try {
    const ls = lstatSync(dir);
    if (ls.isSymbolicLink()) return { ok: false, why: "it is a symlink" };
    if (!ls.isDirectory()) return { ok: false, why: "it is not a folder" };
    if (typeof process.getuid === "function" && ls.uid !== process.getuid())
      return { ok: false, why: "it is not owned by you" };
    if ((ls.mode & 0o077) !== 0)
      return { ok: false, why: "it is open to other users (want mode 0700)" };
    fd = openSync(
      dir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const fs = fstatSync(fd);
    if (fs.dev !== ls.dev || fs.ino !== ls.ino)
      return { ok: false, why: "it changed while it was checked" };
    return { ok: true, dev: fs.dev, ino: fs.ino };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT"
      ? { ok: false, why: "missing" }
      : { ok: false, why: "it cannot be opened safely" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

/** The last lines of a regular file; a symlink, FIFO or device is skipped, never read. */
const tail = (
  path: string,
  dir: { dev: number; ino: number },
): string[] | "skipped" | undefined => {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    if (!fstatSync(fd).isFile()) return "skipped";
    // The folder must still be the one that was checked after the file opened.
    const after = lstatSync(dirname(path));
    if (
      after.isSymbolicLink() ||
      after.dev !== dir.dev ||
      after.ino !== dir.ino
    )
      return "skipped";
    return readFileSync(fd, "utf8").replace(/\n$/, "").split("\n").slice(-TAIL);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ELOOP"
      ? "skipped"
      : undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

/**
 * The last lines of the daemon log the service writes (C9), and of events.log,
 * the daemon's own one-line-per-event log (#2029).
 */
export async function logs(ctx: Ctx): Promise<number> {
  const logDir = join(ctx.home, "logs");
  const path = join(logDir, "daemon.log");
  const eventsPath = join(logDir, "events.log");
  const dir = checkDir(logDir);
  if (!dir.ok && dir.why !== "missing") {
    say(ctx, `Not reading ${tilde(ctx, logDir)}: ${dir.why}.`);
    return 1;
  }
  if (!dir.ok) {
    say(ctx, ctx.copy.noLog(tilde(ctx, path)));
    return 1;
  }
  const show = (p: string, t: ReturnType<typeof tail>) =>
    t === "skipped" ? [`skipped ${tilde(ctx, p)}: not a regular file`] : t;
  const daemon = tail(path, dir);
  const events = tail(eventsPath, dir);
  if (!daemon && !events) {
    say(ctx, ctx.copy.noLog(tilde(ctx, path)));
    return 1;
  }
  const d = daemon && show(path, daemon);
  const e = events && show(eventsPath, events);
  say(ctx, d && e ? [...d, "--- events.log ---", ...e] : (d ?? e ?? []));
  return 0;
}
