import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import { STAGING_ORIGIN, test } from "./fixtures";

test("reads a published HTML artifact from the library and search", async ({
  stagingArtifact: { agent, id, version, title, searchTerm, content },
}) => {
  const fetched = await agent.call("get_artifact", { id });
  expect(fetched.ok, fetched.text).toBe(true);
  expect(fetched.data).toMatchObject({
    artifact: { id, title, format: "html", visibility: "private" },
    version: { version },
    content,
  });

  const library = await agent.call("list_artifacts", {
    scope: "mine",
    q: title,
  });
  expect(library.ok, library.text).toBe(true);
  expect(library.data?.items).toContainEqual(expect.objectContaining({ id }));

  // Search indexing can finish after the publish response.
  await expect
    .poll(
      async () => {
        const search = await agent.call("search_artifacts", { q: searchTerm });
        expect(search.ok, search.text).toBe(true);
        return search.data?.items;
      },
      { timeout: 40_000 },
    )
    .toContainEqual(expect.objectContaining({ id }));
});

test("publishes a signed upload as a new version and restores the original", async ({
  stagingArtifact: { agent, id, version, content },
}) => {
  const path = "uploaded.html";
  const contentType = "text/html";
  const html = "<!doctype html><meta charset=utf-8><p>Uploaded revision</p>";
  const bytes = new TextEncoder().encode(html);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const reserved = await agent.call("create_upload", {
    artifactId: id,
    path,
    size: bytes.byteLength,
    contentType,
    sha256,
  });
  expect(reserved.ok, reserved.text).toBe(true);
  const { uploadId, url } = reserved.data ?? {};
  if (
    typeof uploadId !== "string" ||
    typeof url !== "string" ||
    new URL(url).origin !== STAGING_ORIGIN
  ) {
    throw new Error("Missing or unexpected staging upload URL");
  }
  const put = await fetch(url, {
    method: "PUT",
    body: bytes,
    headers: { "content-type": contentType },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  expect(put.status, "Signed upload PUT").toBe(204);

  const updated = await agent.call("publish_artifact", {
    id,
    expectedVersion: version,
    entry: path,
    files: { [path]: { uploadId } },
  });
  expect(updated.ok, updated.text).toBe(true);
  expect(updated.data).toMatchObject({ id, version: version + 1 });

  const uploaded = await agent.call("get_artifact", { id });
  expect(uploaded.ok, uploaded.text).toBe(true);
  expect(uploaded.data).toMatchObject({
    version: { version: version + 1, entry: path },
    content: html,
  });

  const restored = await agent.call("restore_version", { id, version });
  expect(restored.ok, restored.text).toBe(true);
  expect(restored.data).toMatchObject({ id, version: version + 2 });

  const latest = await agent.call("get_artifact", { id });
  expect(latest.ok, latest.text).toBe(true);
  expect(latest.data).toMatchObject({
    version: { version: version + 2 },
    content,
  });

  const history = await agent.call("list_versions", { id });
  expect(history.ok, history.text).toBe(true);
  expect(history.data).toMatchObject({
    items: [{ version: version + 2 }, { version: version + 1 }, { version }],
  });
});
