import { type Me, R } from "@oa/shared";
import { expect } from "@playwright/test";
import { mcpWithToken } from "../../real/mcp-client";
import {
  readStagingPat,
  STAGING_MCP_URL,
  STAGING_ORIGIN,
  test,
} from "./fixtures";

test.skip(
  !process.env.OA_STAGING_SHARE_PAT_FILE,
  "Set OA_STAGING_SHARE_PAT_FILE to a dedicated staging recipient's PAT file",
);

test("grants and revokes viewer access for a staging member", async ({
  stagingArtifact: { agent, id },
}) => {
  const token = await readStagingPat("OA_STAGING_SHARE_PAT_FILE");
  // Resolve an existing member from their PAT. Sharing to an arbitrary
  // address could send an invitation email.
  const me = await fetch(`${STAGING_ORIGIN}${R.me}`, {
    headers: { authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  expect(me.ok, `Staging recipient identity HTTP ${me.status}`).toBe(true);
  const { user } = (await me.json()) as Pick<Me, "user">;
  if (user?.role !== "member" || !user.email)
    throw new Error("The recipient PAT must belong to a staging member");

  const recipient = await mcpWithToken(
    token,
    "staging-happy-path-recipient",
    STAGING_MCP_URL,
  );
  try {
    const before = await recipient.call("get_artifact", { id });
    expect(before.ok, "Recipient cannot see the private fixture").toBe(false);
    expect(before.text).toMatch(/^not_found:/);

    const target = { id, email: user.email };
    const shared = await agent.call("share_artifact", {
      ...target,
      role: "viewer",
    });
    expect(shared.ok, "Share the fixture with the staging member").toBe(true);
    try {
      expect(shared.data).toMatchObject({ role: "viewer", emailed: false });
      const visible = await recipient.call("get_artifact", { id });
      expect(visible.ok, visible.text).toBe(true);
      expect(visible.data).toMatchObject({
        artifact: { id, access: "viewer" },
      });
    } finally {
      const unshared = await agent.call("unshare_artifact", target);
      expect(unshared.ok, "Revoke the fixture share").toBe(true);
    }

    const after = await recipient.call("get_artifact", { id });
    expect(after.ok, "Recipient cannot see the fixture after revocation").toBe(
      false,
    );
    expect(after.text).toMatch(/^not_found:/);
  } finally {
    await recipient.close();
  }
});
