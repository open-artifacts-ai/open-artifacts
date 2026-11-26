import { type Me, R } from "@oa/shared";
import { expect } from "@playwright/test";
import { type Agent, mcpWithToken } from "../../real/mcp-client";

const get = (origin: string, path: string, token: string) =>
  fetch(new URL(path, origin), {
    headers: { authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });

export async function memberIdentity(origin: string, token: string) {
  const response = await get(origin, R.me, token);
  expect(response.status, "Member token resolves on this instance").toBe(200);
  const { user } = (await response.json()) as Pick<Me, "user">;
  if (user?.role !== "member" || !user.email)
    throw new Error("The recipient token must belong to a staging member");
  return user;
}

export async function checkMemberComments(
  origin: string,
  id: string,
  owner: Agent,
  ownerToken: string,
  memberToken: string,
) {
  const member = await memberIdentity(origin, memberToken);
  const page = await owner.call("get_artifact", { id, includeContent: false });
  expect(page.ok, "Read the private fixture as its owner").toBe(true);
  const ownerId = (page.data?.artifact as { owner?: { id: string } })?.owner
    ?.id;
  expect(ownerId).toBeTruthy();
  expect(member.id, "The two PATs belong to different people").not.toBe(
    ownerId,
  );

  const recipient = await mcpWithToken(
    memberToken,
    "comment-smoke-member",
    `${origin}/mcp`,
  );
  try {
    const target = { id, email: member.email };
    const shared = await owner.call("share_artifact", {
      ...target,
      role: "commenter",
    });
    expect(
      shared.ok,
      "Grant the existing member access to the scratch page",
    ).toBe(true);
    try {
      expect(shared.data).toMatchObject({ role: "commenter", emailed: false });
      const first = await recipient.call("add_comment", {
        id,
        body: "Member smoke comment",
      });
      expect(first.ok, "Member creates a comment").toBe(true);
      // #3163: add_comment returns the short result ({ threadId, commentId }).
      const threadId = first.data?.threadId as string | undefined;
      expect(threadId).toBeTruthy();
      const reply = await owner.call("add_comment", {
        id,
        threadId,
        body: "Owner smoke reply",
      });
      expect(reply.ok, "Owner replies in the same thread").toBe(true);
      for (const client of [owner, recipient]) {
        const read = await client.call("list_comments", { id });
        expect(read.ok).toBe(true);
        expect(read.data).toMatchObject({
          threads: [
            {
              id: threadId,
              comments: [
                {
                  body: "Member smoke comment",
                  author: { kind: "agent", id: member.id },
                },
                {
                  body: "Owner smoke reply",
                  author: { kind: "agent", id: ownerId },
                },
              ],
            },
          ],
        });
      }
      // These receiver controls are exclusive to interactive browser sessions.
      for (const token of [memberToken, ownerToken]) {
        for (const path of [R.agentAskHeld, R.agentListens]) {
          const response = await get(origin, path, token);
          expect(response.status, `Browser-only ${path}`).toBe(403);
          expect(await response.json()).toMatchObject({
            error: {
              code: "forbidden",
              message: expect.stringMatching(/web app in your browser/i),
            },
          });
        }
      }
    } finally {
      const result = await owner.call("unshare_artifact", target);
      expect(result.ok, "Revoke the scratch-page share").toBe(true);
    }
  } finally {
    await recipient.close();
  }
}
