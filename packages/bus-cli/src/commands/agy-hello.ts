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
import {
  BRIEF_RULES,
  connectDaemon,
  type Hello,
  HelloRefused,
  habitsOff,
} from "@oa/bus-ipc";
import { BRIEF_RULES_MAX_BYTES } from "@oa/bus-protocol";
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
  /**
   * Says hello and closes; resolves to the bus name, rejects with the
   * refusal. With `rules`, it first asks the daemon for the bus rules over the
   * same connection (#3043): a string, null when this install opted out, or
   * undefined when the daemon did not say.
   */
  hello: (
    hello: Hello,
    rules: boolean,
  ) => Promise<{ name: string; rules?: string | null }>;
  /** The bus rules without a daemon: the bundled text, or null when opted out. */
  localRules: () => string | null;
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
  hello: async (hello, rules) => {
    const problem = socketDirProblem(ctx.home);
    if (problem) throw new Error(problem);
    const client = await connectDaemon({
      path: daemonSocketPath(ctx.home),
      hello,
      timeoutMs: DAEMON_WAIT_MS,
      requestTimeoutMs: DAEMON_WAIT_MS,
      unref: true,
    });
    const name = client.welcome.bus_name;
    try {
      if (!rules) return { name };
      const r = await client.request({ type: "habits" });
      return r.type === "habits" ? { name, rules: r.rules } : { name };
    } catch {
      return { name };
    } finally {
      client.close();
    }
  },
  localRules: () => (habitsOff(ctx.home) ? null : BRIEF_RULES),
  ppid: process.ppid,
});

/** The event agy ran the hook for, from its payload's `hookEventName`. */
const eventOf = (text: string): string | undefined => {
  try {
    const e = (JSON.parse(text) as { hookEventName?: unknown })?.hookEventName;
    return typeof e === "string" ? e : undefined;
  } catch {
    return undefined;
  }
};

/** Rules fit to inject: a non-empty text under BRIEF_RULES_MAX_BYTES. */
const fits = (r: unknown): r is string =>
  typeof r === "string" &&
  r.trim() !== "" &&
  new TextEncoder().encode(r).length <= BRIEF_RULES_MAX_BYTES;

/**
 * #3043, agy S4: what the hook prints. At SessionStart, the bus rules as one
 * system message agy keeps in the conversation; otherwise, or when opted out,
 * `{}`. Only the rules ever go here: never a sender's or a peer's text.
 */
export function agyHookOutput(rules: string | null | undefined): string {
  return fits(rules)
    ? JSON.stringify({
        injectSteps: [{ systemMessage: { systemMessage: rules } }],
      })
    : "{}";
}

/**
 * agy S2: the hook of the oa-bus agy plugin. agy runs it at a conversation's
 * first message (SessionStart, again after /clear) and before a model call
 * (PreInvocation, for a resumed conversation), with the payload on stdin and
 * no pid in it; the hook's shell skips this when nothing changed. It finds the agy process by walking its own parent
 * chain to the nearest agy binary, records the conversation that process
 * shows now (the MCP server agy started speaks for it), and says hello for
 * it: kind antigravity, the conversation as the agent ref, the agy pid and
 * its start time, which the daemon checks. The daemon homes it by the folder
 * map. It always exits 0: a failed join never stops agy.
 *
 * agy S4 (#3043): at SessionStart it also hands agy the bus rules, which agy
 * keeps in the conversation as a system message: the daemon's, asked over the
 * same connection, else the bundled text. Opted out (`habits.optedOut`), it
 * prints `{}`. No file holds them. PreInvocation never adds them: it runs
 * again after a failed join, and a conversation keeps its start's rules.
 */
export async function agyHello(
  ctx: Ctx,
  over: Partial<AgyHelloDeps> = {},
): Promise<number> {
  const deps = { ...defaults(ctx), ...over };
  const fields: Record<string, string | number> = {};
  let atStart = false;
  let rules: string | null | undefined;
  try {
    const text = await deps.stdin();
    atStart = eventOf(text) === "SessionStart";
    const start = parseSessionStart(text);
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
          const joined = await deps.hello(hello, atStart);
          fields.name = joined.name;
          fields.state = "joined";
          rules = joined.rules;
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
  // agy reads the hook's answer from stdout.
  let out = "{}";
  if (atStart) {
    // Which rules went out, for the log: the daemon's, the bundled ones, none.
    let from = "rules_daemon";
    try {
      // The daemon's answer, unless it gave none that fits; null is the opt-out.
      if (rules !== null && !fits(rules)) {
        from = "rules_bundled";
        rules = deps.localRules();
      }
    } catch {
      rules = undefined;
    }
    out = agyHookOutput(rules);
    fields.code = out === "{}" ? "rules_none" : from;
  }
  say(ctx, out);
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
