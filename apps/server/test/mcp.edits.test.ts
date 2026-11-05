import { env } from "cloudflare:workers";
import type { Client } from "@modelcontextprotocol/client";
import { newId } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPat } from "../src/auth/pat.js";
import { login } from "./helpers.js";
import { connect, textOf, tool } from "./mcp-helpers.js";

// #1216, #1540 over MCP: expectedVersion and edits on publish_artifact.

let client: Client;

beforeAll(async () => {
  const u = await login(`mcp-edits-${newId().slice(0, 6).toLowerCase()}@x.com`);
  client = await connect((await createPat(env, u.userId, "edits")).token);
});
afterAll(async () => {
  await client.close();
});

describe("publish_artifact edits and expectedVersion", () => {
  it("edits publish the next version; a stale expectedVersion and a miss are refused with next steps", async () => {
    const first = await tool(client, "publish_artifact", {
      title: "e",
      format: "markdown",
      content: "# Title\n\nfirst line\n",
    });
    expect(first.isError, textOf(first)).toBeFalsy();
    const { id } = first.structuredContent as { id: string };

    const ok = await tool(client, "publish_artifact", {
      id,
      edits: [{ old: "first line", new: "second line" }],
      expectedVersion: 1,
    });
    expect(ok.isError, textOf(ok)).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ id, version: 2 });
    const read = await tool(client, "get_artifact", { id });
    expect(JSON.stringify(read.structuredContent)).toContain("second line");

    const stale = await tool(client, "publish_artifact", {
      id,
      edits: [{ old: "second line", new: "third" }],
      expectedVersion: 1,
    });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("version_conflict");
    expect(textOf(stale)).toContain("Version 2 is current");

    const miss = await tool(client, "publish_artifact", {
      id,
      edits: [{ old: "nope", new: "x" }],
    });
    expect(miss.isError).toBe(true);
    expect(textOf(miss)).toContain("edit_failed");
    expect(textOf(miss)).toContain("edits[0]");
    expect(textOf(miss)).toContain("get_artifact");
  });

  it("a settings-only publish ignores expectedVersion and makes no version", async () => {
    const first = await tool(client, "publish_artifact", {
      title: "s",
      format: "html",
      content: "<p>x</p>",
    });
    const { id } = first.structuredContent as { id: string };
    const r = await tool(client, "publish_artifact", {
      id,
      description: "d",
      expectedVersion: 9,
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ id, version: 1 });
  });
});
