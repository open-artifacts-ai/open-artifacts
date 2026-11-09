import { expect } from "@playwright/test";
import { test } from "./fixtures";

test("persists a text comment on script-rendered HTML", async ({
  stagingArtifact: { agent, id, version },
}) => {
  const anchor = {
    kind: "text",
    version,
    exact: "both i ≤ j",
    prefix: "Compare ",
    suffix: " before advancing.",
  };
  const body = "Staging selection comment";
  const created = await agent.call("add_comment", { id, body, anchor });
  expect(created.ok, created.text).toBe(true);

  const listed = await agent.call("list_comments", { id });
  expect(listed.ok, listed.text).toBe(true);
  expect(listed.data).toMatchObject({
    threads: [{ anchor, comments: [{ body }] }],
  });
});

test("posts an agent ask with options for the artifact owner", async ({
  stagingArtifact: { agent, id },
}) => {
  const fetched = await agent.call("get_artifact", {
    id,
    includeContent: false,
  });
  expect(fetched.ok, fetched.text).toBe(true);
  const artifact = fetched.data?.artifact as { owner?: { id?: string } };
  const ownerId = artifact?.owner?.id;
  if (!ownerId) throw new Error("Comments fixture has no owner ID");

  const question = "Which example should the staging fixture show?";
  const options = [
    { id: "short", label: "Short example" },
    { id: "full", label: "Full example" },
  ];
  const recommended = { optionId: "short", why: "It is quicker to read." };
  const created = await agent.call("add_comment", {
    id,
    body: question,
    ask: { question, options, recommended, to: [{ key: ownerId }] },
  });
  expect(created.ok, created.text).toBe(true);

  const listed = await agent.call("list_comments", { id });
  expect(listed.ok, listed.text).toBe(true);
  expect(listed.data).toMatchObject({
    threads: [
      {
        anchor: { kind: "note" },
        comments: [
          {
            body: question,
            ask: { question, options, recommended, to: [{ id: ownerId }] },
          },
        ],
      },
    ],
  });
});
