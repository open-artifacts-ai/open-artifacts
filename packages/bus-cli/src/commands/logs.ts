import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Ctx, say, tilde } from "../context.ts";

const TAIL = 50;

/** The last lines of a regular file; a symlink, FIFO or device is skipped, never read. */
const tail = (path: string): string[] | "skipped" | undefined => {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    if (!fstatSync(fd).isFile()) return "skipped";
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
  const path = join(ctx.home, "logs", "daemon.log");
  const eventsPath = join(ctx.home, "logs", "events.log");
  const show = (p: string, t: ReturnType<typeof tail>) =>
    t === "skipped" ? [`skipped ${tilde(ctx, p)}: not a regular file`] : t;
  const daemon = tail(path);
  const events = tail(eventsPath);
  if (!daemon && !events) {
    say(ctx, ctx.copy.noLog(tilde(ctx, path)));
    return 1;
  }
  const d = daemon && show(path, daemon);
  const e = events && show(eventsPath, events);
  say(ctx, d && e ? [...d, "--- events.log ---", ...e] : (d ?? e ?? []));
  return 0;
}
