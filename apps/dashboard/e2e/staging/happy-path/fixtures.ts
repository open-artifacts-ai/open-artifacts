import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test as base, expect } from "@playwright/test";
import { type Agent, mcpWithToken } from "../../real/mcp-client";

export const STAGING_ORIGIN = "https://staging.open-artifacts.com";
export const STAGING_MCP_URL = `${STAGING_ORIGIN}/mcp`;
const ARTIFACT_HTML = `<!doctype html>
<meta charset="utf-8">
<p id="comparison"></p>
<script>
  document.querySelector("#comparison").innerHTML =
    "Compare <b>both</b> <code>i</code> &le; <code>j</code> before advancing.";
</script>`;

type StagingArtifact = {
  agent: Agent;
  id: string;
  version: number;
  title: string;
  searchTerm: string;
  content: string;
};

export async function readStagingPat(variable: string): Promise<string> {
  const tokenFile = process.env[variable];
  if (!tokenFile) throw new Error(`Set ${variable} to a staging PAT file`);
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!token) throw new Error(`The PAT file for ${variable} is empty`);
  return token;
}

export const test = base.extend<{ stagingArtifact: StagingArtifact }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured first argument.
  stagingArtifact: async ({}, use) => {
    const agent = await mcpWithToken(
      await readStagingPat("OA_STAGING_PAT_FILE"),
      "staging-happy-path",
      STAGING_MCP_URL,
    );
    const runId = randomUUID().replaceAll("-", "");
    const searchTerm = `oaquality${runId}`;
    const title = `Staging happy path ${runId}`;
    const content = `${ARTIFACT_HTML}\n<p>${searchTerm}</p>`;
    let artifactId: string | undefined;
    try {
      const published = await agent.call("publish_artifact", {
        title,
        format: "html",
        visibility: "private",
        comments: true,
        content,
      });
      const { id, version } = published.data ?? {};
      if (!published.ok || typeof id !== "string")
        throw new Error(`Publishing staging fixture failed: ${published.text}`);
      artifactId = id;
      if (typeof version !== "number")
        throw new Error("Staging fixture has no version");
      await use({ agent, id, version, title, searchTerm, content });
    } finally {
      try {
        // A lost publish response can leave a fixture behind. The unique title
        // is indexed with the artifact, so look it up before closing the client.
        if (!artifactId) {
          const listed = await agent.call("list_artifacts", {
            scope: "mine",
            visibility: "private",
            q: runId,
          });
          expect(listed.ok, `Find fixture for cleanup: ${listed.text}`).toBe(
            true,
          );
          const items = listed.data?.items as { id: string; title: string }[];
          artifactId = items.find((item) => item.title === title)?.id;
        }
        if (artifactId) {
          const deleted = await agent.call("delete_artifact", {
            id: artifactId,
          });
          expect(
            deleted.ok,
            `Trash fixture ${artifactId}: ${deleted.text}`,
          ).toBe(true);
        }
      } finally {
        await agent.close();
      }
    }
  },
});
