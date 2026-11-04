import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Daemon,
  type DaemonDeps,
  runDaemon,
  START_ERROR_CODES,
} from "@oa/bus-daemon";
import { type Ctx, sayErr } from "../context.ts";
import { readMachine } from "../machine.ts";
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
      // Only an older token was revoked: a restart picks up the new one.
      onRevoked: (replaced) => end(replaced ? 1 : REVOKED_EXIT),
      // Exit non-zero: the service restarts the daemon, which binds again.
      onSocketLost: () => end(1),
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
