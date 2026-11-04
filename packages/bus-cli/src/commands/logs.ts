import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Ctx, say, tilde } from "../context.ts";

const TAIL = 50;

/** The last lines of the daemon log the service writes (C9). */
export async function logs(ctx: Ctx): Promise<number> {
  const path = join(ctx.home, "logs", "daemon.log");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    say(ctx, ctx.copy.noLog(tilde(ctx, path)));
    return 1;
  }
  const lines = text.replace(/\n$/, "").split("\n");
  say(ctx, lines.slice(-TAIL));
  return 0;
}
