import { env } from "cloudflare:workers";
import type { Client } from "@modelcontextprotocol/client";
import { newId } from "@oa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPat } from "../src/auth/pat.js";
import { login } from "./helpers.js";
import { close, connect, textOf, tool } from "./mcp-helpers.js";

// #2015: publish_artifact's result carries the artifact's current title, so a
// client that did not send a title (edits-only, settings-only) can show it.

let client: Client;

beforeAll(async () => {
  const u = await login(`mcp-title-${newId().slice(0, 6).toLowerCase()}@x.com`);
  client = await connect((await createPat(env, u.userId, "title")).token);
});
afterAll(async () => {
  await close(client);
});

const call = async (args: Record<string, unknown>) => {
  const r = await tool(client, "publish_artifact", args);
  expect(r.isError, textOf(r)).toBeFalsy();
  const out = r.structuredContent as {
    id: string;
    version: number;
    url: string;
    title?: string;
  };
  return out;
};

describe("publish_artifact returns the current title", () => {
  it("create, edits-only, settings-only and a renaming publish", async () => {
    const created = await call({
      title: "First title",
      format: "markdown",
      content: "# Hi\n\nalpha\n",
    });
    expect(created.title).toBe("First title");

    const edited = await call({
      id: created.id,
      edits: [{ old: "alpha", new: "beta" }],
    });
    expect(edited.version).toBe(2);
    expect(edited.title).toBe("First title");

    const settings = await call({ id: created.id, description: "d" });
    expect(settings.version).toBe(2);
    expect(settings.title).toBe("First title");

    const renamedSettings = await call({ id: created.id, title: "Second" });
    expect(renamedSettings.title).toBe("Second");

    const renamedPublish = await call({
      id: created.id,
      title: "Third",
      format: "markdown",
      content: "# Hi\n",
    });
    expect(renamedPublish.version).toBe(3);
    expect(renamedPublish.title).toBe("Third");

    const after = await call({
      id: created.id,
      edits: [{ old: "# Hi", new: "# Hello" }],
    });
    expect(after.title).toBe("Third");
    expect(Object.keys(after).sort()).toEqual(
      ["id", "title", "url", "version"].sort(),
    );
  });
});
