import { join } from "node:path";
import {
  askDaemon,
  type Ctx,
  isolated,
  say,
  sayErr,
  tilde,
  tildeReason,
} from "../context.ts";
import { readMachine } from "../machine.ts";
import {
  readAssets,
  uninstallAdapters,
  unshownNotes,
} from "../steps/adapters.ts";
import { uninstallClaudePlugins } from "../steps/claude-plugins.ts";
import { removeHabits } from "../steps/habits.ts";
import { hermesHome } from "../steps/hermes.ts";
import { readMade, removeMade } from "../steps/leftovers.ts";
import { uninstallOutputStyle } from "../steps/output-style.ts";
import { removeShim } from "../steps/path-shim.ts";
import { purge } from "../steps/purge.ts";
import { isDefaultHome } from "../steps/service.ts";
import { uninstallSkill } from "../steps/skill.ts";

const originOf = (hub: string) => {
  try {
    return new URL(hub.replace(/^ws(s?):/, "http$1:")).origin;
  } catch {
    return hub;
  }
};

/** Takes this bus out of the harness configs, the skill, the plugins, the habits and the shim. */
async function unwire(ctx: Ctx): Promise<void> {
  const c = ctx.copy;
  const r = await uninstallAdapters({
    home: ctx.userHome,
    busHome: ctx.home,
    env: ctx.env,
    // Removing an entry never names the bin.
    busBin: [],
    assets: readAssets(),
    which: ctx.which,
    exec: ctx.exec,
    codexApp: ctx.codexApp,
    isolated: isolated(ctx),
  });
  if (r.removed.length > 0) say(ctx, c.removedFrom(r.removed));
  // The skill files go with the wiring: only the ones carrying our header.
  // Every harness, not only the ones unwired now: an install may have written
  // a skill for a harness this run did not touch.
  try {
    const skills = uninstallSkill({ home: ctx.userHome, env: ctx.env });
    for (const n of skills.notes) say(ctx, [n]);
  } catch (e) {
    say(ctx, [
      `Could not remove the skill files: ${e instanceof Error ? e.message : String(e)}`,
    ]);
  }
  // The Claude Code plugins we recorded, and the marketplace only if we added it.
  try {
    const plugins = await uninstallClaudePlugins({
      home: ctx.userHome,
      busHome: ctx.home,
      env: ctx.env,
      exec: ctx.exec,
      copy: c,
    });
    for (const n of plugins.notes) say(ctx, [n]);
  } catch (e) {
    say(ctx, c.pluginsRemoveFailed(e instanceof Error ? e.message : String(e)));
  }
  // The Claude Code output style setting, and an older install's marked file.
  try {
    const style = uninstallOutputStyle({
      home: ctx.userHome,
      busHome: ctx.home,
      env: ctx.env,
    });
    for (const n of style.notes) say(ctx, [n]);
  } catch (e) {
    say(ctx, [
      `Could not remove the output style: ${e instanceof Error ? e.message : String(e)}`,
    ]);
  }
  // The always-on habits block goes too: only our marked block, nothing else.
  try {
    const habits = removeHabits({
      home: ctx.userHome,
      env: ctx.env,
      busHome: ctx.home,
    });
    for (const n of habits.notes) say(ctx, [n]);
  } catch (e) {
    say(ctx, [
      `Could not remove the habits block: ${e instanceof Error ? e.message : String(e)}`,
    ]);
  }
  // The oa-bus command (#1626): only our shim, only for this bus home.
  try {
    const gone = removeShim({
      userHome: ctx.userHome,
      busHome: ctx.home,
      platform: ctx.platform,
    });
    if (gone) say(ctx, c.shimRemoved(tilde(ctx, gone)));
  } catch (e) {
    say(ctx, [
      `Could not remove the oa-bus command: ${e instanceof Error ? e.message : String(e)}`,
    ]);
  }
  // Quiet on success: the wiring lines above already say what was removed.
  if (r.hermesNoCli)
    say(
      ctx,
      c.hermesNoCli(
        tilde(ctx, join(hermesHome(ctx.userHome, ctx.env), "config.yaml")),
      ),
    );
  if (r.openclawNoCli) say(ctx, c.openclawNoCli());
  if (r.openclawNix) say(ctx, c.openclawNix());
  for (const n of unshownNotes(r.notes)) say(ctx, [n]);
  if (r.folderOnly.includes("opencode")) say(ctx, c.removedPluginFolder());
  if (r.removed.length + r.folderOnly.length === 0) say(ctx, c.noneWired());
  for (const s of r.skipped)
    say(
      ctx,
      c.couldNotRemove(s.harness, tildeReason(ctx, s.harness, s.reason)),
    );
  if ([...r.removed, ...r.folderOnly].includes("opencode")) {
    if (r.opencodeRestartByUser)
      say(ctx, c.opencodeRestartYourself(r.opencodeIsolated));
    else if (r.opencodeRestarted) say(ctx, c.restartedUnload());
    else if (
      r.notes.some((n) => n.startsWith("opencode service restart failed"))
    )
      say(ctx, c.opencodeNotRunningUnload());
  }
}

/** Transcript states 9 and 10. Exit 0. */
export async function uninstall(
  opts: { purge: boolean },
  ctx: Ctx,
): Promise<number> {
  const c = ctx.copy;
  say(ctx, c.header(ctx.version), "");
  // Read before anything is deleted: the closing lines name them.
  const machine = readMachine(ctx.home);

  const removed = await ctx.service.remove();
  if (removed.skipped) say(ctx, c.serviceOtherHome(removed.skipped, true));
  else if (removed.unit) say(ctx, c.serviceRemoved(removed.unit));
  else if (removed.stopped) say(ctx, c.daemonStopped());
  else if (removed.running === undefined) say(ctx, c.noService());
  if (removed.running !== undefined)
    say(ctx, c.daemonStillRunning(removed.running));

  // A second bus home never wired a harness: those configs belong to the first bus.
  if (isDefaultHome(ctx.home, ctx.userHome)) await unwire(ctx);

  if (!opts.purge) {
    say(ctx, "", c.kept(tilde(ctx, join(ctx.home, "machine.json"))));
    return 0;
  }
  const home = tilde(ctx, ctx.home);
  try {
    await askDaemon(ctx, { timeoutMs: 1000 });
    // Its socket and stores would come back the moment we removed them.
    sayErr(ctx, c.purgeDaemonRunning(home));
    return 1;
  } catch {}
  // install.json goes with the purge, so its record of what install made is read first.
  const made = readMade(join(ctx.home, "install.json"));
  const out = purge(ctx.home, {
    isDefault: ctx.home === join(ctx.userHome, ".oa-bus"),
  });
  if ("refused" in out) {
    sayErr(ctx, c.purgeRefused(home));
    return 1;
  }
  // Files and folders install made in the harnesses' configs, once empty again.
  try {
    removeMade(made);
  } catch (e) {
    say(ctx, [
      `Could not remove the empty files install made: ${e instanceof Error ? e.message : String(e)}`,
    ]);
  }
  say(ctx, out.leftDir ? c.purgeLeftDir(home) : c.deleted(home));
  if (machine.state === "ok")
    say(ctx, "", c.stillListed(machine.label, originOf(machine.hub)));
  return 0;
}
