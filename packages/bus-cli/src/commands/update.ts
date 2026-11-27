import {
  clearInstallRequest,
  label,
  loginActive,
  readPolicy,
  requestInstall,
  updateCommand,
} from "@oa/bus-daemon";
import { wiredTo } from "../bus-cmd.ts";
import { type Ctx, say, sayErr } from "../context.ts";
import { originOf, readMachine } from "../machine.ts";
import { recordClaudeProof } from "../steps/adapters.ts";

/** Installs the staged version; true once it is the running one. */
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
    now: ctx.now(),
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
      case "refused_backoff":
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
  // #2688: an install from before the Claude config was recorded gets it now.
  const m = readMachine(ctx.home);
  if (m.state === "ok" && ctx.which("claude") && wiredTo(ctx))
    recordClaudeProof({
      home: ctx.userHome,
      busHome: ctx.home,
      env: ctx.env,
      busBin: ctx.service.argv?.() ?? [],
      hub: originOf(m.hub),
    });
  say(ctx, c.updateDone(version));
  return 0;
}

/** How long the person waits for the restart and the daemon's 60 s check. */
export const INSTALL_WAIT_MS = 100_000;
const POLL_MS = 500;

/**
 * Leaves the daemon a request to switch to the staged version, through the
 * same path the updater takes (re-hash, pending, swap, restart, self-check),
 * and waits for it to be the current version. Refuses while a login or an
 * approval is in progress: the restart would cut it off.
 */
export async function installViaDaemon(
  ctx: Ctx,
  version: string,
  waitMs = INSTALL_WAIT_MS,
): Promise<boolean> {
  const c = ctx.copy;
  if (loginActive(ctx.home)) {
    sayErr(ctx, c.updateBusy());
    return false;
  }
  const priorFailures = readPolicy(ctx.home).startFailures[version]?.count ?? 0;
  requestInstall(ctx.home, version, ctx.now());
  for (let waited = 0; waited <= waitMs; waited += POLL_MS) {
    const s = readPolicy(ctx.home);
    if (s.current === version && !s.pending) return true;
    if ((s.startFailures[version]?.count ?? 0) > priorFailures) break;
    await ctx.sleep(POLL_MS);
  }
  clearInstallRequest(ctx.home);
  sayErr(ctx, c.updateNotInstalled(version));
  return false;
}
