import { resolve } from "node:path";
import { daemon } from "./commands/daemon.ts";
import { doctor } from "./commands/doctor.ts";
import { global } from "./commands/global.ts";
import { install, loginStep } from "./commands/install.ts";
import { logs } from "./commands/logs.ts";
import { mcp } from "./commands/mcp.ts";
import { status } from "./commands/status.ts";
import { uninstall } from "./commands/uninstall.ts";
import { askDaemon, type Ctx, realCtx, say, sayErr } from "./context.ts";
import { type Command, parse } from "./index.ts";

/**
 * `oa-bus <argv>`. Resolves the exit code, or undefined when the command
 * keeps running on its own (`mcp`).
 */
export async function main(
  argv: string[],
  makeCtx: (noColor: boolean) => Ctx = realCtx,
): Promise<number | undefined> {
  let cmd: Command;
  try {
    cmd = parse(argv);
  } catch (e) {
    const ctx = makeCtx(argv.includes("--no-color"));
    sayErr(ctx, ctx.copy.usage(e instanceof Error ? e.message : String(e)));
    return 2;
  }
  const ctx = makeCtx(cmd.noColor);
  if (cmd.home) ctx.home = resolve(cmd.home);
  try {
    return await dispatch(cmd, ctx);
  } catch (e) {
    sayErr(ctx, ctx.copy.failed(e instanceof Error ? e.message : String(e)));
    return 1;
  }
}

async function dispatch(cmd: Command, ctx: Ctx): Promise<number | undefined> {
  switch (cmd.cmd) {
    case "install":
      return install(
        {
          hub: cmd.hub,
          noOpen: cmd.noOpen,
          check: cmd.check,
          noService: cmd.noService,
        },
        ctx,
      );
    case "login": {
      say(ctx, ctx.copy.header(ctx.version), "");
      const ok = await loginStep(ctx, {
        hub: cmd.hub,
        noOpen: cmd.noOpen,
        force: true,
      });
      if (!ok) return 1;
      // login never restarts the daemon: it keeps the token it started with.
      const pid = await askDaemon(ctx, { timeoutMs: 1000 }).then(
        (st) => st.pid,
        () => undefined,
      );
      if (pid !== undefined) say(ctx, ctx.copy.daemonOldToken(pid));
      return 0;
    }
    case "daemon":
      // The daemon reads both from the environment, as the service sets them.
      if (cmd.home) process.env.OA_BUS_HOME = ctx.home;
      if (cmd.hub) process.env.OA_BUS_INSTANCE = cmd.hub;
      return daemon(ctx);
    case "mcp":
      // The adapter servers read OA_BUS_HOME themselves.
      if (cmd.home) process.env.OA_BUS_HOME = ctx.home;
      return mcp(cmd.harness, ctx);
    case "status":
      return status(ctx);
    case "logs":
      return logs(ctx);
    case "doctor":
      return doctor(ctx);
    case "uninstall":
      return uninstall({ purge: cmd.purge }, ctx);
    case "global":
      return global(cmd, ctx);
    case "version":
      say(ctx, ctx.copy.header(ctx.version));
      return 0;
  }
}
