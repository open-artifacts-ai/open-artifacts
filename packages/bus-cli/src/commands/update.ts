import { label, readPolicy, updateCommand } from "@oa/bus-daemon";
import { type Ctx, say, sayErr } from "../context.ts";

/** PR 4 replaces this with the real install of the staged version. */
export type InstallStaged = (version: string) => Promise<boolean>;

/**
 * `oa-bus update` (#2552): installs only the version already staged and
 * proven. No flag, no env, no argument; a person types `yes`. Not a security
 * boundary: it only brings forward an install the instance already named.
 */
export async function update(
  ctx: Ctx,
  installStaged: InstallStaged,
): Promise<number> {
  const c = ctx.copy;
  const s = readPolicy(ctx.home);
  const d = updateCommand(s, {
    stdinTTY: ctx.stdinIsTTY === true,
    stdoutTTY: ctx.stdout.isTTY === true,
  });
  if (!d.ok) {
    switch (d.reason) {
      case "not_a_terminal":
        sayErr(ctx, c.updateNotATerminal());
        return 2;
      case "off":
        sayErr(ctx, c.updateOff());
        return 1;
      case "failed":
        sayErr(ctx, c.updateFailedVersion(s.staged?.version ?? ""));
        return 1;
      default:
        say(ctx, c.updateNothingStaged(label(s, ctx.now())));
        return 0;
    }
  }
  const version = (s.staged as { version: string }).version;
  const answer = (await ctx.readLine?.(c.updatePrompt(version))) ?? "";
  if (answer.trim().toLowerCase() !== "yes") {
    say(ctx, c.updateDeclined());
    return 1;
  }
  if (!(await installStaged(version))) return 1;
  say(ctx, c.updateDone(version));
  return 0;
}
