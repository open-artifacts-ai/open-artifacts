// edit_doc (#1100): agent edits to a doc, through its room. The MCP tool and
// POST /api/v1/artifacts/:id/doc/ops both come here.
import type { EditDocBody, EditDocResult, Member } from "@oa/shared";
import { authorize, callerOf } from "../auth/authz.js";
import type { Contributor } from "../docs/versions.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { type AgentAttr, viaKey } from "./agent-usage.js";
import { docsNeedPaid, docsUnavailable } from "./doc-format.js";
import { DOC_SWITCH } from "./doc-switch.js";
import { docsAvailable } from "./docs-available.js";

/** Who an edit counts as: the agent behind the credential, else the person. */
export function contributorFor(
  user: Member,
  agent: AgentAttr | null,
): Contributor {
  if (!agent) return { kind: "person", key: user.id, userId: user.id };
  const via = agent.via ? viaKey(agent.via) : agent.name;
  return {
    kind: "agent",
    key: `agent:${via}`,
    userId: user.id,
    agentName: agent.name,
    agentVersion: agent.version,
    agentVia: agent.via ? viaKey(agent.via) : null,
  };
}

/**
 * Applies `body.ops` to doc `id`. Needs the caller to publish (edit access,
 * the plan lock and token caps are `authorize`'s). Refused, nothing applied:
 * not a doc, a stale expectedVersion, or any doc-ops error.
 */
export async function editDoc(
  env: Env,
  user: Member,
  agent: AgentAttr | null,
  id: string,
  body: EditDocBody,
): Promise<EditDocResult> {
  const { artifact } = await authorize(env, callerOf(user), id, "publish");
  if (artifact.doc !== 1)
    throw new ApiError(
      "bad_request",
      "This artifact is not a doc. edit_doc changes docs only; publish a new version of other artifacts with publish_artifact.",
      { path: "id", reason: "not_a_doc" },
    );
  if (!docsAvailable(env))
    throw DOC_SWITCH.creation ? docsNeedPaid() : docsUnavailable();
  if (
    body.expectedVersion !== undefined &&
    body.expectedVersion !== artifact.currentVersion
  )
    throw new ApiError(
      "version_conflict",
      `Version ${artifact.currentVersion} is current. Read it with get_artifact and apply your change to it.`,
      { currentVersion: artifact.currentVersion },
    );
  const rooms = env.DOC_ROOM;
  if (!rooms)
    throw new ApiError("storage_unavailable", "Doc rooms are unavailable");
  const r = await rooms.get(rooms.idFromName(id)).applyOps({
    ops: body.ops,
    by: contributorFor(user, agent),
  });
  if (!r.ok) {
    const { code, message, ...rest } = r.error;
    throw new ApiError(
      code === "doc_too_large" ? "too_large" : "bad_request",
      message,
      { path: "ops", reason: code, ...rest },
    );
  }
  return {
    id,
    version: r.version,
    bytes: r.bytes,
    applied: r.applied,
    ...(r.savedVersion === undefined ? {} : { savedVersion: r.savedVersion }),
    changes: r.changes,
  };
}
