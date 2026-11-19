import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  clearPending,
  compareVersions,
  type FetchedRelease,
  fetchRelease,
  loginActive,
  parseVersion,
  ReleaseError,
  readPolicy,
  setPending,
  stage,
  unpackTo,
  type VerifiedRelease,
  verifyRelease,
} from "@oa/bus-daemon";
import { type Ctx, say, sayErr } from "../context.ts";
import { readMachine } from "../machine.ts";
import { isDefaultHome } from "../steps/service.ts";
import { healthzBody } from "./status.ts";

/** What `upgrade` leans on, so a test can bring its own network and installer. */
export type UpgradeDeps = {
  fetchRelease: (v: string) => Promise<FetchedRelease>;
  verifyRelease: (r: FetchedRelease) => VerifiedRelease;
  /** Runs the verified copy's installer; its exit code. */
  runInstaller: (entry: string, args: string[]) => number;
  /** Tests only: runs between the unpack and the installer, as a prune would. */
  beforeInstall?: (dest: string) => void;
};

export const realUpgradeDeps = (ctx: Ctx): UpgradeDeps => ({
  fetchRelease,
  verifyRelease,
  runInstaller: (entry, args) =>
    spawnSync(process.execPath, [entry, ...args], {
      stdio: "inherit",
      env: { ...process.env, OA_BUS_HOME: ctx.home },
    }).status ?? 1,
});

/** The instance's own version from its /healthz (same origin only), or undefined. */
async function serverVersion(
  ctx: Ctx,
  hub: string,
): Promise<string | undefined> {
  try {
    const res = await ctx.fetch(`${hub.replace(/\/+$/, "")}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    if (new URL(res.url || hub).origin !== new URL(hub).origin)
      return undefined;
    return (await healthzBody(res)).version;
  } catch {
    return undefined;
  }
}

/**
 * `oa-bus upgrade [x.y.z]` (#2543): a hand upgrade through the installed bus.
 * It fetches the release from the pinned registry, proves it with the
 * updater's own check (the same pins and Node floor), unpacks it into
 * versions/<v>, and runs THAT copy's installer. Nothing is installed from a
 * copy that was not proven, and there is no npx fallback. Forward only, and
 * never ahead of the instance, except the exact kept previous version.
 */
export async function upgrade(
  ctx: Ctx,
  opts: { version?: string; allowFailed?: boolean },
  deps: UpgradeDeps = realUpgradeDeps(ctx),
): Promise<number> {
  const c = ctx.copy;
  const m = readMachine(ctx.home);
  if (m.state !== "ok") {
    sayErr(ctx, c.upgradeNotInstalled());
    return 1;
  }
  if (opts.version !== undefined && parseVersion(opts.version) === undefined) {
    sayErr(ctx, c.upgradeUsage());
    return 2;
  }
  const server = await serverVersion(ctx, m.hub);
  if (server === undefined) {
    sayErr(ctx, c.upgradeNoServerVersion());
    return 1;
  }
  const policy = readPolicy(ctx.home);
  const running = ctx.version;
  // Same gates as `oa-bus update`: a person at a terminal, updates on.
  if (policy.unreadable) {
    sayErr(ctx, c.updateOff());
    return 1;
  }
  if (policy.off) {
    sayErr(ctx, c.updateOff());
    return 1;
  }
  if (ctx.stdinIsTTY !== true || ctx.stdout.isTTY !== true) {
    sayErr(ctx, c.updateNotATerminal());
    return 2;
  }
  let target = opts.version;
  if (target === undefined) {
    if (parseVersion(server) === undefined) {
      sayErr(ctx, c.upgradePreRelease(server));
      return 1;
    }
    target = server;
  }
  const named = opts.version !== undefined;
  // Never ahead of the instance: it vouches for what its machines may run.
  const base = server.split(/[-+]/)[0] ?? server;
  const preRelease = parseVersion(server) === undefined;
  if (
    parseVersion(base) === undefined ||
    compareVersions(target, base) > 0 ||
    (preRelease && compareVersions(target, base) === 0)
  ) {
    sayErr(ctx, c.upgradeAhead(target, server));
    return 1;
  }
  // A step back only when the person names the version: a bare `upgrade`
  // follows the instance forward, never back.
  const isPrevious = named && policy.previous === target;
  if (policy.failed.includes(target) && opts.allowFailed !== true) {
    sayErr(ctx, c.upgradeFailedVersion(target));
    return 1;
  }
  // A dev or pre-release build compares by its x.y.z base.
  const runBase = running.split(/[-+]/)[0] ?? running;
  if (parseVersion(runBase) === undefined) {
    sayErr(ctx, c.upgradeNotForward(target, running));
    return 1;
  }
  {
    const cmp = compareVersions(target, runBase);
    if (cmp === 0 && runBase === running) {
      say(ctx, c.upgradeCurrent(running));
      return 0;
    }
    if (cmp < 0 && !isPrevious) {
      sayErr(ctx, c.upgradeNotForward(target, running));
      return 1;
    }
  }

  if (loginActive(ctx.home)) {
    sayErr(ctx, c.updateBusy());
    return 1;
  }
  const answer = (await ctx.readLine?.(c.updatePrompt(target))) ?? "";
  if (answer.trim().toLowerCase() !== "yes") {
    say(ctx, c.updateDeclined());
    return 1;
  }
  say(ctx, c.upgradeChecking(target));
  let verified: VerifiedRelease;
  try {
    verified = deps.verifyRelease(await deps.fetchRelease(target));
  } catch (e) {
    // Nothing was written: the install is as it was.
    sayErr(
      ctx,
      c.upgradeRefused(
        target,
        e instanceof ReleaseError ? e.code : "fetch_failed",
      ),
    );
    return 1;
  }
  const launcher = join(ctx.home, "bin", "node");
  let dest: string;
  try {
    dest = stage(ctx.home, target, (dir) => {
      unpackTo(verified.entries, dir);
      if (!existsSync(join(dir, "dist", "index.js")))
        throw new Error("the release has no dist/index.js");
      // The launcher the service and the harness entries run; the installer
      // replaces it with one for this node.
      if (existsSync(launcher)) {
        copyFileSync(launcher, join(dir, "node"));
        chmodSync(join(dir, "node"), 0o700);
      }
    });
  } catch {
    sayErr(ctx, c.upgradeRefused(target, "bad_tar"));
    return 1;
  }
  // A daemon prune must not take the unpacked copy before its installer runs:
  // mark it live for this process, and check it is still whole.
  const marker = join(dest, ".live", String(process.pid));
  try {
    mkdirSync(join(dest, ".live"), { recursive: true, mode: 0o700 });
    writeFileSync(marker, "", { mode: 0o600 });
  } catch {
    // best effort; the check below still catches a missing copy
  }
  deps.beforeInstall?.(dest);
  const entry = join(dest, "dist", "index.js");
  if (!existsSync(entry)) {
    sayErr(ctx, c.upgradeStaleStage(target));
    return 1;
  }
  say(ctx, c.upgradeInstalling(target));
  const args = ["install", "--instance", m.hub];
  if (!isDefaultHome(ctx.home, ctx.userHome)) args.push("--home", ctx.home);
  if (ctx.service.kind === undefined && !ctx.service.fallback)
    args.push("--no-service");
  // Never --habits or --no-habits: the person answers that question themselves.
  // A switch under way, so a bad install steps back on its own: the daemon's
  // self-check reads `pending`, as it does for an update it started.
  setPending(ctx.home, { from: runBase, to: target, startedAt: ctx.now() });
  const code = deps.runInstaller(entry, args);
  rmSync(marker, { force: true });
  if (code !== 0) {
    clearPending(ctx.home);
    sayErr(ctx, c.upgradeInstallFailed(target, code));
    return code;
  }
  return 0;
}
