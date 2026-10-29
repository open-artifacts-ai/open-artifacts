import {
  type AgentTouch,
  type Member,
  PRESENCE_ACTIVITY_MAX,
} from "@oa/shared";
import type { Env } from "../env.js";
import { logError } from "../log.js";
import type { AgentAttr } from "../services/agent-usage.js";
import { runtimeStub } from "./do.js";
import { cleanName, presenceName } from "./roster.js";
import { viewerPresenceKey } from "./viewer-presence-key.js";

/**
 * Who an agent call came from, for viewer presence. `connection` is
 * `t:<tokenId>`, `g:<grantId>` or `c:<userId>`; `session` the verified
 * legacy-era MCP session (one face per session), else null (one face per
 * connection). Neither ever reaches a client: both only feed the HMAC key.
 */
export type ViewerAgentFrom = {
  user: Member;
  agent: AgentAttr | null;
  session: string | null;
  connection: string;
  write: boolean;
  activity: string | null;
};

/**
 * The DO's AgentTouch for one agent call. `product` is an OAuth grant's
 * client name only: a PAT's `agent.name` is its token label, which goes to
 * `label` (owner-only, via buildRoster's `labels`) and never to the product.
 * The owner is the presence name (never the email), else "Member".
 */
export async function viewerAgentTouch(
  env: Pick<Env, "SESSION_SECRET">,
  artifactId: string,
  o: ViewerAgentFrom,
): Promise<AgentTouch> {
  const via = o.agent?.via?.kind;
  const activity = cleanName(o.activity);
  return {
    key: await viewerPresenceKey(
      env,
      artifactId,
      `a:${o.session ?? o.connection}`,
    ),
    product: via === "grant" ? cleanName(o.agent?.name ?? null) : null,
    owner: presenceName(o.user) ?? "Member",
    ownerActor: `u:${o.user.id}`,
    // A grant's owner-set label (#559) is not loaded here yet: null.
    label: via === "token" ? cleanName(o.agent?.name ?? null) : null,
    write: o.write,
    activity:
      activity === null
        ? null
        : [...activity].slice(0, PRESENCE_ACTIVITY_MAX).join(""),
  };
}

/**
 * The one extra DO call viewer presence costs: an agent read (get_artifact,
 * GET R.artifact) that otherwise never reaches the artifact's DO. In
 * waitUntil, never awaited by the request; failures are logged only.
 */
export function touchViewerAgentLater(
  env: Pick<Env, "SESSION_SECRET" | "ARTIFACT_RUNTIME">,
  exec: Pick<ExecutionContext, "waitUntil"> | undefined,
  artifactId: string,
  o: ViewerAgentFrom,
): void {
  const p = viewerAgentTouch(env, artifactId, o)
    .then((t) => runtimeStub(env, artifactId).touchViewerAgent(t))
    .catch((e) => logError("viewer_presence_touch_failed", e));
  if (exec) exec.waitUntil(p);
}

/** A touch for a DO call that already happens; null (and logged) on failure, so the call goes ahead. */
export async function viewerAgentTouchOrNull(
  env: Pick<Env, "SESSION_SECRET">,
  artifactId: string,
  o: ViewerAgentFrom | null,
): Promise<AgentTouch | undefined> {
  if (!o) return undefined;
  try {
    return await viewerAgentTouch(env, artifactId, o);
  } catch (e) {
    logError("viewer_presence_touch_failed", e);
    return undefined;
  }
}

/** REST with a PAT: connection `t:<tokenId>`, no session. Null for any other caller. */
export function restViewerAgent(
  v: { user: Member | null; tokenId: string | null; tokenLabel: string | null },
  write: boolean,
  activity: string | null = null,
): ViewerAgentFrom | null {
  if (!v.user || !v.tokenId) return null;
  return {
    user: v.user,
    agent: {
      name: v.tokenLabel ?? "",
      version: null,
      via: { kind: "token", id: v.tokenId },
    },
    session: null,
    connection: `t:${v.tokenId}`,
    write,
    activity,
  };
}
