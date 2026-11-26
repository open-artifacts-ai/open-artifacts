import { join } from "node:path";
import {
  type AgyConversation,
  agyHello as agyHelloFrame,
  agyTitle,
  daemonSocketPath,
  findAgy,
  nameFromTitle,
  type Proc,
  parseSessionStart,
  procStartOf,
  readProc,
  socketDirProblem,
  writeAgyConversation,
} from "@oa/bus-adapter-claude-code";
import { createEventLog } from "@oa/bus-daemon";
import { connectDaemon, type Hello, HelloRefused } from "@oa/bus-ipc";
import { type Ctx, say } from "../context.ts";

/** The most the hook waits for agy's payload on stdin. */
const STDIN_WAIT_MS = 5000;
/** The most the hook waits for the daemon's answer. */
const DAEMON_WAIT_MS = 3000;
/** The most the hook waits for its log line. */
const LOG_WAIT_MS = 300;
/** agy's payload is small; anything larger is not one. */
const STDIN_MAX = 256 * 1024;

/** The event each hook run logs, joined or not. */
export const AGY_HELLO_EVENT = "agy_hello";

export type AgyHelloDeps = {
  /** agy's SessionStart payload. */
  stdin: () => Promise<string>;
  proc: Proc;
  procStart: (pid: number) => string | null;
  title: (conversationId: string) => Promise<string | undefined>;
  /** Says hello and closes; resolves to the bus name, rejects with the refusal. */
  hello: (hello: Hello) => Promise<string>;
  /** The hook's parent: the shell agy ran the hook in, or agy itself. */
  ppid: number;
};

/** Reads stdin to its end, bounded in size and time. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = () => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(done, STDIN_WAIT_MS);
    timer.unref();
    process.stdin.on("data", (c: Buffer) => {
      size += c.length;
      if (size > STDIN_MAX) return done();
      chunks.push(c);
    });
    process.stdin.once("end", done);
    process.stdin.once("error", done);
  });
}

const defaults = (ctx: Ctx): AgyHelloDeps => ({
  stdin: readStdin,
  proc: readProc,
  procStart: procStartOf,
  title: (id) => agyTitle(id),
  hello: async (hello) => {
    const problem = socketDirProblem(ctx.home);
    if (problem) throw new Error(problem);
    const client = await connectDaemon({
      path: daemonSocketPath(ctx.home),
      hello,
      timeoutMs: DAEMON_WAIT_MS,
      unref: true,
    });
    const name = client.welcome.bus_name;
    client.close();
    return name;
  },
  ppid: process.ppid,
});

/**
 * agy S2: the hook of the oa-bus agy plugin. agy runs it at a conversation's
 * first message (SessionStart, again after /clear) and before a model call
 * (PreInvocation, for a resumed conversation), with the payload on stdin and
 * no pid in it; the hook's shell skips this when nothing changed. It finds the agy process by walking its own parent
 * chain to the nearest agy binary, records the conversation that process
 * shows now (the MCP server agy started speaks for it), and says hello for
 * it: kind antigravity, the conversation as the agent ref, the agy pid and
 * its start time, which the daemon checks. The daemon homes it by the folder
 * map. It always prints `{}` and exits 0: a failed join never stops agy.
 */
export async function agyHello(
  ctx: Ctx,
  over: Partial<AgyHelloDeps> = {},
): Promise<number> {
  const deps = { ...defaults(ctx), ...over };
  const fields: Record<string, string | number> = {};
  try {
    const start = parseSessionStart(await deps.stdin());
    if (!start) fields.reason = "bad_payload";
    const agy = start ? findAgy(deps.ppid, deps.proc) : undefined;
    if (start && agy === undefined) fields.reason = "no_agy_ancestor";
    const procStart = agy === undefined ? null : deps.procStart(agy);
    if (agy !== undefined && procStart === null)
      fields.reason = "agy_not_running";
    if (start && agy !== undefined && procStart !== null) {
      fields.pid = agy;
      fields.ref = start.conversationId;
      const name = nameFromTitle(await deps.title(start.conversationId));
      const conv: AgyConversation = {
        pid: agy,
        procStart,
        conversationId: start.conversationId,
        cwd: start.cwd,
        ...(name === undefined ? {} : { name }),
      };
      const hello = agyHelloFrame(conv);
      if (!hello) fields.reason = "bad_hello";
      else
        try {
          fields.name = await deps.hello(hello);
          fields.state = "joined";
          // Only once the daemon took it: the MCP server then speaks for this
          // conversation, and the hook's shell skips Node until it changes.
          writeAgyConversation(ctx.home, conv);
        } catch (e) {
          fields.reason =
            e instanceof HelloRefused
              ? "refused"
              : (e as { code?: unknown })?.code === "ENOENT" ||
                  (e as { code?: unknown })?.code === "ECONNREFUSED"
                ? "daemon_unreachable"
                : "daemon_error";
        }
    }
  } catch {
    fields.reason ??= "error";
  }
  // agy reads the hook's answer from stdout: nothing to add to the turn.
  say(ctx, "{}");
  try {
    const events = createEventLog(join(ctx.home, "logs", "events.log"));
    events(AGY_HELLO_EVENT, fields);
    // Bounded: a slow disk never holds agy up.
    await Promise.race([
      events.flush(),
      new Promise((r) => setTimeout(r, LOG_WAIT_MS).unref()),
    ]);
  } catch {}
  return 0;
}
