import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Ctx, say, tilde } from "../context.ts";

const TAIL = 50;

const tail = (path: string): string[] | undefined => {
  try {
    return readFileSync(path, "utf8")
      .replace(/\n$/, "")
      .split("\n")
      .slice(-TAIL);
  } catch {
    return undefined;
  }
};

/**
 * The last lines of the daemon log the service writes (C9), and of events.log,
 * the daemon's own one-line-per-event log (#2029).
 */
export async function logs(ctx: Ctx): Promise<number> {
  const path = join(ctx.home, "logs", "daemon.log");
  const daemon = tail(path);
  const events = tail(join(ctx.home, "logs", "events.log"));
  if (!daemon && !events) {
    say(ctx, ctx.copy.noLog(tilde(ctx, path)));
    return 1;
  }
  say(
    ctx,
    daemon && events
      ? [...daemon, "--- events.log ---", ...events]
      : (daemon ?? events ?? []),
  );
  return 0;
}
