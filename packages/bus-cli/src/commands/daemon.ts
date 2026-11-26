import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEventLog,
  type Daemon,
  type DaemonDeps,
  defaultSkillRefresher,
  runDaemon,
  START_ERROR_CODES,
} from "@oa/bus-daemon";
import { wiredTo } from "../bus-cmd.ts";
import { type Ctx, sayErr } from "../context.ts";
import { originOf, readMachine } from "../machine.ts";
import { reapplyClaudeProof } from "../steps/adapters.ts";
import { readRecord } from "../steps/claude-proof.ts";
import { PROOF_EVENT } from "../steps/claude-proof-check.ts";
import { REVOKED_EXIT } from "../steps/service.ts";

export type Signals = Pick<NodeJS.Process, "once" | "off">;

/**
 * A start failure no restart fixes: the daemon's StartError codes, or a file
 * it may not read or write (EACCES, EPERM: owned by another user).
 */
export const lasting = (e: unknown): boolean =>
  [...START_ERROR_CODES, "EACCES", "EPERM"].includes(
    (e as { code?: unknown } | null)?.code as string,
  );

/**
 * The daemon in the foreground; the service runs this same command.
 * Resolves 0 on SIGINT or SIGTERM and 78, once, when the hub revokes this
 * machine: systemd does not restart on 78, and launchd's one restart finds
 * the revoked marker and exits 0, so no service loops on a dead token.
 * Under a service (OA_BUS_SERVICE=1, set by the unit) a lasting start
 * failure exits 0 too; in a terminal it exits 1.
 */
export async function daemon(
  ctx: Ctx,
  run: (deps: DaemonDeps) => Promise<Daemon> = runDaemon,
  signals: Signals = process,
): Promise<number> {
  // A marker for an older token is stale: `login` saved a newer one since.
  const m = readMachine(ctx.home);
  if (
    existsSync(join(ctx.home, "revoked")) &&
    (m.state !== "ok" || m.revoked)
  ) {
    sayErr(ctx, ctx.copy.revoked());
    return 0;
  }
  // Always on: ~/.oa-bus/logs/events.log (the service owns daemon.log's fd); `oa-bus logs` shows both.
  const events = createEventLog(join(ctx.home, "logs", "events.log"));
  // #2688: an update restarts the daemon, so this also runs after `oa-bus update`.
  // Only for a bus the harness configs name, and only in the Claude config
  // file install recorded: another bus, or a config nothing was recorded for,
  // is never touched.
  const config = readRecord(join(ctx.home, "install.json")).config;
  if (m.state === "ok" && config !== undefined && wiredTo(ctx))
    reapplyClaudeProof(
      {
        home: ctx.userHome,
        busHome: ctx.home,
        env: ctx.env,
        busBin: ctx.service.argv?.() ?? [],
        hub: originOf(m.hub),
        config,
      },
      (c) => events(PROOF_EVENT, { name: c.entry, kind: c.scope }),
    );
  return new Promise<number>((resolve) => {
    let running: Daemon | undefined;
    let ended = false;
    const end = (code: number) => {
      if (ended) return;
      ended = true;
      signals.off("SIGINT", onSignal);
      signals.off("SIGTERM", onSignal);
      void (running?.stop() ?? Promise.resolve()).finally(() => resolve(code));
    };
    const onSignal = () => end(0);
    signals.once("SIGINT", onSignal);
    signals.once("SIGTERM", onSignal);
    run({
      version: ctx.version,
      events,
      // Only an older token was revoked: a restart picks up the new one.
      onRevoked: (replaced) => end(replaced ? 1 : REVOKED_EXIT),
      // Exit non-zero: the service restarts the daemon, which binds again.
      onSocketLost: () => end(1),
      // #2552: the updater ends the daemon non-zero to restart it from a new `bin`.
      update: { entryFile: fileURLToPath(import.meta.url), exit: end },
      // #3203: a new instance release rewrites the installed skills.
      skillRefresh: defaultSkillRefresher(
        ctx.home,
        (msg) => sayErr(ctx, msg),
        fileURLToPath(import.meta.url),
      ),
    }).then(
      (d) => {
        running = d;
        if (ended) void d.stop();
      },
      (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        sayErr(
          ctx,
          (e as { code?: unknown } | null)?.code === "SOCKET_PATH"
            ? ctx.copy.socketPathFailed(msg)
            : ctx.copy.failed(msg),
        );
        end(ctx.env.OA_BUS_SERVICE === "1" && lasting(e) ? 0 : 1);
      },
    );
  });
}
