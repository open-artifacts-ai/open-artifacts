import { callTool, TOOLS, type ToolResult } from "@oa/bus-adapter-claude-code";
import { CLIENT_VERSION, type DaemonClient, Hello } from "@oa/bus-ipc";
import { BusNameSchema, LIMITS } from "@oa/bus-protocol";
import type { OpenCodeSession } from "./session.ts";

export { TOOLS, type ToolResult };

/** OpenCode sets this on every tools/call; the model does not control it. */
export const SESSION_META = "ai.opencode/sessionID";

/** OpenCode's placeholder until it titles a session: no name at all. */
const UNTITLED = /^New session - /;

/** A title as a bus name: lowercase words joined by `-`; `opencode` when nothing valid is left. */
export function nameOf(title: string | null): string {
  if (!title || UNTITLED.test(title)) return "opencode";
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, LIMITS.maxBusNameChars)
    .replace(/-+$/, "");
  return BusNameSchema.safeParse(slug).success ? slug : "opencode";
}

const text = (t: string): ToolResult => ({
  content: [{ type: "text", text: t }],
  isError: true,
});

/**
 * One OpenCode service hosts every session's MCP calls, so identity is per
 * call: `_meta`'s session id, mapped to its root. Tool arguments never name
 * the sender. One daemon connection per call, closed after it.
 */
export async function handleToolCall(input: {
  name: string;
  args: Record<string, unknown>;
  meta: Record<string, unknown> | undefined;
  connect: (hello: Hello) => Promise<DaemonClient>;
  resolve: (sessionId: string) => Promise<OpenCodeSession | null>;
  /** Aborted when OpenCode cancels the call. */
  signal?: AbortSignal;
}): Promise<ToolResult> {
  try {
    const sessionId = input.meta?.[SESSION_META];
    if (typeof sessionId !== "string" || !sessionId)
      return text("oa-bus: this OpenCode version did not send a session id.");
    const session = await input.resolve(sessionId);
    if (!session)
      return text(`oa-bus: OpenCode could not find session ${sessionId}.`);
    if (!session.directory)
      return text(
        `oa-bus: OpenCode did not say which directory session ${session.root} is in.`,
      );
    const hello = Hello.parse({
      v: 1,
      id: "hello",
      type: "hello",
      kind: "opencode",
      client_version: CLIENT_VERSION,
      agent_ref: session.root,
      pid: process.pid,
      cwd: session.directory,
      proposed_name: nameOf(session.title),
      attest: { session_id: sessionId },
    });
    let client: DaemonClient;
    try {
      client = await input.connect(hello);
    } catch (e) {
      return text(
        `oa-bus: the daemon did not accept this session (${e instanceof Error ? e.message : String(e)}).`,
      );
    }
    try {
      return await callTool(input.name, input.args, client, input.signal);
    } finally {
      client.close();
    }
  } catch (e) {
    // The service is shared by every session: a throw here would take them all.
    return text(`oa-bus: ${e instanceof Error ? e.message : String(e)}`);
  }
}
