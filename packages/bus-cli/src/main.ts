import { resolve } from "node:path";
import { useBusCmd } from "./bus-cmd.ts";
import { daemon } from "./commands/daemon.ts";
import { doctor } from "./commands/doctor.ts";
import { global } from "./commands/global.ts";
import { install, loginStep } from "./commands/install.ts";
import { leads } from "./commands/leads.ts";
import { link } from "./commands/link.ts";
import { logs } from "./commands/logs.ts";
import { mcp } from "./commands/mcp.ts";
import { mcpProof } from "./commands/mcp-proof.ts";
import { namespace } from "./commands/namespace.ts";
import { status } from "./commands/status.ts";
import { uninstall } from "./commands/uninstall.ts";
import { askDaemon, type Ctx, realCtx, say, sayErr } from "./context.ts";
import { type Command, parse } from "./index.ts";

/** Commands that print to a terminal and survive the shim: see `main`. */
const TERMINAL = new Set([
  "login",
  "status",
  "logs",
  "doctor",
  "global",
  "namespace",
  "link",
  "leads",
  "version",
  "help",
]);

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
  // Only commands whose text goes to a person's terminal print oa-bus. The
  // daemon writes daemon.log, and mcp, mcp-proxy and mcp-proof write to an
  // agent's MCP stderr, so they keep npx. An install prints npx until its shim
  // step has run; uninstall removes the shim, so it prints npx too. Usage
  // errors keep npx.
  if (cmd.cmd === "install" ? cmd.check || cmd.habits : TERMINAL.has(cmd.cmd))
    useBusCmd(ctx);
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
          habits: cmd.habits,
          json: cmd.json,
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
    case "mcp-proof":
      // The daemon socket is found from OA_BUS_HOME, as the adapter servers do.
      return mcpProof({ tokenFile: cmd.tokenFile }, ctx);
    case "mcp-proxy": {
      // #1856: OpenCode's or Codex's stand-in for the instance's /mcp; stdio, no listener.
      if (cmd.home) process.env.OA_BUS_HOME = ctx.home;
      if (cmd.for === "codex") {
        const { startCodexProxy } = await import(
          "@oa/bus-adapter-claude-code/codex-proxy"
        );
        await startCodexProxy({
          instance: cmd.hub,
          ...(cmd.tokenFile ? { tokenFile: cmd.tokenFile } : {}),
          ...(cmd.tokenEnv ? { tokenEnv: cmd.tokenEnv } : {}),
        });
        return undefined;
      }
      const { startProxy } = await import("@oa/bus-adapter-opencode/proxy");
      await startProxy({
        instance: cmd.hub,
        ...(cmd.tokenFile ? { tokenFile: cmd.tokenFile } : {}),
      });
      return undefined;
    }
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
    case "namespace":
      return namespace(cmd, ctx);
    case "leads":
      return leads(cmd, ctx);
    case "link":
      return link(cmd, ctx);
    case "version":
      say(ctx, ctx.copy.header(ctx.version));
      return 0;
    case "help":
      say(ctx, ctx.copy.help());
      return 0;
  }
}
