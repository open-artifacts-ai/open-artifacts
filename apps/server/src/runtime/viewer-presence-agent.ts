// The Worker side of AI agents on the viewer-presence roster (#539): builds
// the AgentTouch an artifact read, publish, restore or data call carries to the
// artifact's DO. An agent has no socket; it shows while its requests keep
// arriving.
import type { AgentTouch, Member } from "@oa/shared";
import type { Env } from "../env.js";
import { logError } from "../log.js";
import { cleanName, shownName } from "../services/agent-display.js";
import type { AgentAttr } from "../services/agent-usage.js";
import { runtimeStub } from "./do.js";
import { viewerPresenceKey } from "./viewer-presence-key.js";

/** What a request knows about the agent making it; the artifact id turns it into a touch. */
export type AgentTouchInput = {
  user: Member;
  agent: AgentAttr | null;
  /** The verified server-issued MCP session (legacy era), else null. */
  session: string | null;
  /** `t:<tokenId>`, `g:<grantId>` or `c:<userId>` (see mcp/session.ts). */
  connection: string;
  write: boolean;
  activity: string | null;
};

/**
 * Key = per-artifact HMAC of the session, else the connection, so two
 * sessions of one client are two faces and one session shows once.
 * `product` is a grant's client name only: for a token the name is the
 * owner's private label, which goes to `label` (the owner's own sockets) and
 * never becomes a product or a name.
 */
export async function viewerAgentTouch(
  env: Pick<Env, "SESSION_SECRET">,
  artifactId: string,
  o: AgentTouchInput,
): Promise<AgentTouch> {
  const via = o.agent?.via?.kind;
  return {
    key: await viewerPresenceKey(
      env,
      artifactId,
      `a:${o.session ?? o.connection}`,
    ),
    product: via === "grant" ? cleanName(o.agent?.name ?? null) : null,
    owner: shownName(o.user),
    ownerActor: `u:${o.user.id}`,
    label: via === "token" ? cleanName(o.agent?.name ?? null) : null,
    write: o.write,
    activity: cleanName(o.activity),
  };
}

/** The touch, or undefined (logged) when it can't be built: presence never fails a request. */
export async function safeViewerAgentTouch(
  env: Pick<Env, "SESSION_SECRET">,
  artifactId: string,
  o: AgentTouchInput | undefined,
): Promise<AgentTouch | undefined> {
  if (!o) return undefined;
  try {
    return await viewerAgentTouch(env, artifactId, o);
  } catch (e) {
    logError("viewer_presence_touch_failed", e);
    return undefined;
  }
}

/**
 * The one extra DO call for an agent read that reaches no DO otherwise, in
 * waitUntil. Errors are logged (`viewer_presence_touch_failed`; the UserPresence
 * accept path's own log is `presence_touch_failed`).
 */
export function touchViewerAgentLater(
  env: Env,
  exec: Pick<ExecutionContext, "waitUntil"> | undefined,
  artifactId: string,
  o: AgentTouchInput,
): Promise<void> {
  const run = async () => {
    try {
      await runtimeStub(env, artifactId).touchViewerAgent(
        await viewerAgentTouch(env, artifactId, o),
      );
    } catch (e) {
      logError("viewer_presence_touch_failed", e);
    }
  };
  const p = run();
  exec?.waitUntil(p);
  return p;
}
