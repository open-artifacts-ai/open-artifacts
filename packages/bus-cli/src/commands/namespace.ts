import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type Approval,
  approveCommand,
  canonicalPath,
  isApproved,
  namespacesFile,
  readApprovals,
  readOwnFile,
  sameDir,
  writeApprovals,
} from "@oa/bus-daemon";
import { BusConfigSchema, CONFIG_FILE } from "@oa/bus-protocol";
import { type Ctx, plain, say, sayErr, tilde } from "../context.ts";

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
 * The user's namespace approvals (#1525): a `.oa-bus.json` namespace that
 * differs from the derived one takes effect only for a directory approved
 * here. A session reads it when it registers, so one already running changes
 * only when it restarts.
 */
export async function namespace(
  opts:
    | { sub: "approve"; dir: string; yes: boolean }
    | { sub: "revoke"; dir: string }
    | { sub: "list" },
  ctx: Ctx,
): Promise<number> {
  const c = ctx.copy;
  say(ctx, c.header(ctx.version), "");
  // An unusable file approves nothing, and is never overwritten unread.
  const file = namespacesFile(ctx.home);
  const { entries, error } = readApprovals(file);
  if (error) {
    sayErr(ctx, c.nsUnusable(tilde(ctx, file), error));
    return 1;
  }
  if (opts.sub === "list") {
    say(
      ctx,
      entries.length
        ? c.nsList(entries.map((e) => ({ ...e, dir: shown(ctx, e.dir) })))
        : c.nsNone(),
    );
    return 0;
  }
  const given = resolve(ctx.cwd, opts.dir);
  let real: string | undefined;
  try {
    // Stored as the volume spells it; compared by identity.
    real = canonicalPath(given);
  } catch {}

  if (opts.sub === "revoke") {
    const keep = entries.filter(
      (e) =>
        e.dir !== given && e.dir !== real && !(real && sameDir(e.dir, real)),
    );
    if (keep.length === entries.length) {
      say(ctx, c.nsNotListed(shown(ctx, real ?? given)));
      return 0;
    }
    writeApprovals(keep, ctx.home);
    say(ctx, c.nsRevoked(shown(ctx, real ?? given)));
    return 0;
  }

  if (!real || !statSync(real).isDirectory()) {
    sayErr(ctx, c.nsNotDir(shown(ctx, real ?? given)));
    return 1;
  }
  const cfgFile = join(real, CONFIG_FILE);
  const own = readOwnFile(cfgFile, process.getuid?.(), {
    allowGroupWrite: true,
  });
  if (own.state === "none") {
    sayErr(ctx, c.nsNoFile(shown(ctx, real)));
    return 1;
  }
  if (own.state === "unsafe") {
    sayErr(ctx, c.nsFileUnusable(shown(ctx, cfgFile), own.why));
    return 1;
  }
  let ns: string | undefined;
  try {
    const parsed = BusConfigSchema.safeParse(JSON.parse(own.text));
    if (parsed.success) ns = parsed.data.namespace;
  } catch {}
  if (!ns) {
    say(ctx, c.nsNoNamespace(shown(ctx, cfgFile)));
    return 1;
  }
  if (isApproved(real, ns, entries)) {
    say(ctx, c.nsAlready(shown(ctx, real), plain(ns)));
    return 0;
  }
  if (!opts.yes) {
    if (!ctx.stdinIsTTY || !ctx.readLine) {
      sayErr(ctx, c.nsNeedTty(`${approveCommand(real)} --yes`));
      return 1;
    }
    say(ctx, c.nsAsk(shown(ctx, real), plain(ns)));
    const answer = (await ctx.readLine(c.nsPrompt())).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      say(ctx, c.nsDeclined());
      return 1;
    }
  }
  // One approval per directory: a new namespace replaces the old.
  const next: Approval[] = [
    ...entries.filter((e) => !sameDir(e.dir, real)),
    { dir: real, namespace: ns },
  ];
  writeApprovals(next, ctx.home);
  say(ctx, c.nsApproved(shown(ctx, real), plain(ns)));
  return 0;
}
