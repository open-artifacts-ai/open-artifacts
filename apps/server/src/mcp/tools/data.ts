import type { McpServer } from "@modelcontextprotocol/server";
import { authorize, canCtx } from "../../auth/authz.js";
import { can, dataWriteCreates } from "../../auth/policy.js";
import { recordDataCreator } from "../../billing/creators.js";
import { ApiError } from "../../http/errors.js";
import {
  type RuntimeStub,
  runtimeCall,
  runtimeStub,
} from "../../runtime/do.js";
import { capsOf } from "../../runtime/routes.js";
import { guard, ok, type ToolEnv } from "../server.js";
import { toolConfig } from "../tool-defs.js";

/**
 * The artifact's runtime DO after the access check, as on the REST runtime
 * routes (spec §6.7): `can(level, "data.read" | "data.write")` (else 404),
 * then the `db` capability (403 capability_denied, since access is already
 * proven), except for the uncapped personal owner, so an agent can seed data
 * before declaring db (B14, narrowed: `can(level, "data.seed")`). Capped
 * callers can't write.
 */
export async function store(
  t: Pick<ToolEnv, "env" | "caller">,
  id: string,
  action: "data.read" | "data.write",
): Promise<RuntimeStub> {
  return (await storeOf(t, id, action)).s;
}

/** store(), and whether a write counts its caller as a creator (editor level or above). */
async function storeOf(
  t: Pick<ToolEnv, "env" | "caller">,
  id: string,
  action: "data.read" | "data.write",
): Promise<{ s: RuntimeStub; creator: boolean }> {
  const { level, artifact: a } = await authorize(t.env, t.caller, id, action);
  if (
    !capsOf(a.capabilities).db &&
    !can(level, "data.seed", canCtx(t.caller, a))
  )
    throw new ApiError(
      "capability_denied",
      "This artifact does not declare the db capability",
    );
  return {
    s: runtimeStub(t.env, id),
    creator:
      action === "data.write" &&
      t.caller.kind === "user" &&
      dataWriteCreates(level),
  };
}

export function registerDataTools(server: McpServer, t: ToolEnv): void {
  // Same actor as the user's REST writes: one rate bucket per user.
  const actor = `u:${t.user.id}`;
  /** After a successful write: CREATOR (an agent counts for its owner). */
  const counted = (creator: boolean) =>
    creator ? recordDataCreator(t.env, t.user.id, Date.now()) : undefined;
  const where = (id: string, collection: string) =>
    `${id} collection "${collection}"`;

  server.registerTool(
    "artifact_data_get",
    toolConfig("artifact_data_get"),
    (i) =>
      guard(async () => {
        const s = await store(t, i.id, "data.read");
        const doc = await runtimeCall(() => s.get(i.collection, i.docId));
        return ok(
          `${doc ? "Found" : "No"} document "${i.docId}" in ${where(i.id, i.collection)}`,
          { doc },
        );
      }),
  );

  server.registerTool(
    "artifact_data_list",
    toolConfig("artifact_data_list"),
    (i) =>
      guard(async () => {
        const s = await store(t, i.id, "data.read");
        const page = await runtimeCall(() =>
          s.list(i.collection, i.cursor, i.limit),
        );
        return ok(
          `${page.items.length} documents in ${where(i.id, i.collection)}${page.nextCursor ? " (more: pass cursor)" : ""}`,
          page,
        );
      }),
  );

  server.registerTool(
    "artifact_data_query",
    toolConfig("artifact_data_query"),
    (i) =>
      guard(async () => {
        const s = await store(t, i.id, "data.read");
        const page = await runtimeCall(() => s.query(i.collection, i.query));
        return ok(
          `${page.items.length} matching documents in ${where(i.id, i.collection)}${page.nextCursor ? " (more: pass cursor)" : ""}`,
          page,
        );
      }),
  );

  server.registerTool(
    "artifact_data_set",
    toolConfig("artifact_data_set"),
    (i) =>
      guard(async () => {
        const { s, creator } = await storeOf(t, i.id, "data.write");
        const doc = await runtimeCall(() =>
          s.set(i.collection, i.docId, i.data, actor),
        );
        await counted(creator);
        return ok(`Set "${i.docId}" in ${where(i.id, i.collection)}`, doc);
      }),
  );

  server.registerTool(
    "artifact_data_update",
    toolConfig("artifact_data_update"),
    (i) =>
      guard(async () => {
        const { s, creator } = await storeOf(t, i.id, "data.write");
        const doc = await runtimeCall(() =>
          s.update(i.collection, i.docId, i.patch, actor),
        );
        await counted(creator);
        return ok(`Updated "${i.docId}" in ${where(i.id, i.collection)}`, doc);
      }),
  );

  server.registerTool(
    "artifact_data_delete",
    toolConfig("artifact_data_delete"),
    (i) =>
      guard(async () => {
        const { s, creator } = await storeOf(t, i.id, "data.write");
        await runtimeCall(() => s.delete(i.collection, i.docId, actor));
        await counted(creator);
        return ok(`Deleted "${i.docId}" from ${where(i.id, i.collection)}`, {
          id: i.id,
          collection: i.collection,
          docId: i.docId,
          deleted: true,
        });
      }),
  );
}
