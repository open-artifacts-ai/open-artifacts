// The command printed in the terminal (#1998): `oa-bus` once the PATH shim from
// #1626 is on this shell's PATH and runs this install, otherwise the npx form.
// Never used for text that outlives the run (instruction files, unit files,
// skills): those keep BUS_CMD, because a later shell may not have the shim.

import { BUS_CMD } from "@oa/bus-protocol";
import { type Ctx, tilde } from "./context.ts";
import { copy } from "./copy.ts";
import { shimState } from "./steps/path-shim.ts";
import { isDefaultHome } from "./steps/service.ts";

export type BusCmdOpts = {
  userHome: string;
  busHome: string;
  /** "linux", "darwin", "win32", or ctx.platform ("linux x64"). */
  platform: string;
  env: { PATH?: string };
};

export function busCmd(o: BusCmdOpts): string {
  try {
    return shimState(o)?.kind === "ours" ? "oa-bus" : BUS_CMD;
  } catch {
    return BUS_CMD;
  }
}

/** The copy for this run: a second bus home's errors name `login --home`, never `install` (#2425). */
export function copyFor(ctx: Ctx, cmd: string = ctx.busCmd) {
  const second = !isDefaultHome(ctx.home, ctx.userHome);
  return copy(
    ctx.style,
    cmd,
    second
      ? `${cmd} login --home ${tilde(ctx, ctx.home)} --instance <url>`
      : undefined,
  );
}

/** Sets the printed command on `ctx` once for this run, and rebuilds its copy to match. */
export function useBusCmd(ctx: Ctx): void {
  const cmd = busCmd({
    userHome: ctx.userHome,
    busHome: ctx.home,
    platform: ctx.platform,
    env: ctx.env,
  });
  if (cmd === ctx.busCmd) return;
  ctx.busCmd = cmd;
  ctx.copy = copyFor(ctx, cmd);
}
