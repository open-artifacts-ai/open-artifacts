import {
  daemonSocketPath,
  socketDirProblem,
} from "@oa/bus-adapter-claude-code";
import { daemonHabits } from "@oa/bus-ipc";
import type { Ctx } from "../context.ts";

/** Overall timeout for the Codex SessionStart hook CLI (#3043). */
export const CODEX_HOOK_TIMEOUT_MS = 3_000;

/**
 * #3043: formats the daemon's bus rules as the one-line JSON Codex expects
 * from a SessionStart hook, or "" when opted out, empty, or unavailable.
 * Never throws: a hook must never break a Codex session.
 */
export async function codexHookOutput(
  ask: () => Promise<string | null>,
): Promise<string> {
  let text: string | null;
  try {
    text = await ask();
  } catch {
    return "";
  }
  if (typeof text !== "string" || text.length === 0) return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: text,
    },
  });
}

/**
 * `oa-bus rules codex-hook` (#3043). Queries the daemon for the current bus
 * rules and prints one JSON line when active; prints nothing and exits 0
 * otherwise. Never writes any file.
 */
export async function rules(
  _cmd: { sub: "codex-hook" },
  ctx: Pick<Ctx, "home" | "stdout">,
): Promise<number> {
  if (socketDirProblem(ctx.home)) return 0;
  const line = await codexHookOutput(() =>
    daemonHabits({
      path: daemonSocketPath(ctx.home),
      timeoutMs: CODEX_HOOK_TIMEOUT_MS,
    }),
  );
  if (line) ctx.stdout.write(`${line}\n`);
  return 0;
}
