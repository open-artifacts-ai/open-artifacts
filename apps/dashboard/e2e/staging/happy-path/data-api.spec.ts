import { expect } from "@playwright/test";
import { test } from "./fixtures";

test("writes, updates, queries, and deletes artifact live data", async ({
  stagingArtifact: { agent, id, version },
}) => {
  const enabled = await agent.call("publish_artifact", {
    id,
    capabilities: { db: true },
    dataWriters: "editors",
  });
  expect(enabled.ok, enabled.text).toBe(true);
  expect(enabled.data).toMatchObject({ id, version });
  const artifact = await agent.call("get_artifact", {
    id,
    includeContent: false,
  });
  expect(artifact.ok, artifact.text).toBe(true);
  expect(artifact.data).toMatchObject({
    artifact: { capabilities: { db: true }, dataWriters: "editors" },
  });

  const collection = "votes";
  const docId = "sample";
  const target = { id, collection, docId };
  const created = await agent.call("artifact_data_set", {
    ...target,
    data: { choice: "short", count: 1 },
  });
  expect(created.ok, created.text).toBe(true);
  const initial = await agent.call("artifact_data_get", target);
  expect(initial.ok, initial.text).toBe(true);
  expect(initial.data).toMatchObject({
    doc: { id: docId, data: { choice: "short", count: 1 } },
  });

  const updated = await agent.call("artifact_data_update", {
    ...target,
    patch: { count: 2 },
  });
  expect(updated.ok, updated.text).toBe(true);
  const query = await agent.call("artifact_data_query", {
    id,
    collection,
    query: { where: { choice: "short" } },
  });
  expect(query.ok, query.text).toBe(true);
  expect(query.data).toMatchObject({
    items: [{ id: docId, data: { choice: "short", count: 2 } }],
  });

  const deleted = await agent.call("artifact_data_delete", target);
  expect(deleted.ok, deleted.text).toBe(true);
  const after = await agent.call("artifact_data_get", target);
  expect(after.ok, after.text).toBe(true);
  expect(after.data).toMatchObject({ doc: null });
});
