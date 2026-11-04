import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalPath,
  globalFile,
  isGlobalDir,
  readGlobalDirs,
  sameDir,
  writeGlobalDirs,
} from "@oa/bus-daemon";
import { type Ctx, say, sayErr, tilde } from "../context.ts";

/** `~/code/ops`: the home as `~`, whether or not the user's home was given through a symlink. */
function shown(ctx: Ctx, path: string): string {
  const t = tilde(ctx, path);
  if (t !== path) return t;
  try {
    return tilde({ userHome: realpathSync(ctx.userHome) }, path);
  } catch {
    return path;
  }
}

/**
 * Transcript state 11. The user's allowlist, the only source of global: a
 * repo's `.oa-bus.json` never grants it. A session reads it when it
 * registers, so one already running changes only when it restarts.
 */
export async function global(
  opts: { sub: "add" | "rm"; dir: string } | { sub: "list" },
  ctx: Ctx,
): Promise<number> {
  const c = ctx.copy;
  say(ctx, c.header(ctx.version), "");
  // An unusable file grants nothing, and is never overwritten unread.
  const file = globalFile(ctx.home);
  const { dirs, error } = readGlobalDirs(file);
  if (error) {
    sayErr(ctx, c.globalUnusable(tilde(ctx, file), error));
    return 1;
  }
  if (opts.sub === "list") {
    say(
      ctx,
      dirs.length
        ? c.globalList(dirs.map((d) => shown(ctx, d)))
        : c.globalNone(),
    );
    return 0;
  }
  const given = resolve(ctx.cwd, opts.dir);
  let real: string | undefined;
  try {
    // Stored as the volume spells it; compared by identity (C19).
    real = canonicalPath(given);
  } catch {}
  if (opts.sub === "add") {
    if (!real || !statSync(real).isDirectory()) {
      sayErr(ctx, c.globalNotDir(shown(ctx, real ?? given)));
      return 1;
    }
    // Listed, or under a listed directory: already covered.
    if (isGlobalDir(real, dirs)) {
      say(ctx, c.globalAlready(shown(ctx, real)));
      return 0;
    }
    // Read, then replaced whole; a concurrent add or rm may lose one.
    writeGlobalDirs([...dirs, real], ctx.home);
    say(ctx, c.globalAdded(shown(ctx, real)));
    return 0;
  }
  // Only an entry itself is removed, matched by identity; a subdirectory it
  // covers stays global through it. A directory removed since it was added
  // is matched as given.
  const keep = dirs.filter(
    (d) => d !== given && d !== real && !(real && sameDir(d, real)),
  );
  if (keep.length === dirs.length) {
    say(ctx, c.globalNotListed(shown(ctx, real ?? given)));
    return 0;
  }
  writeGlobalDirs(keep, ctx.home);
  say(ctx, c.globalRemoved(shown(ctx, real ?? given)));
  return 0;
}
