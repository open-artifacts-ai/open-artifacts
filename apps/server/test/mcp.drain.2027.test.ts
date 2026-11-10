import { env } from "cloudflare:workers";
import type { Client } from "@modelcontextprotocol/client";
import { newId } from "@oa/shared";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createPat } from "../src/auth/pat.js";
import { login } from "./helpers.js";
import { connect, settle, tool } from "./mcp-helpers.js";

// #2027: tool() must await the waitUntil work its call started.

let client: Client;
beforeAll(async () => {
  const u = await login(`mcp-drain-${newId().slice(0, 6).toLowerCase()}@x.com`);
  client = await connect((await createPat(env, u.userId, "drain")).token);
});
afterAll(async () => {
  await client.close();
});

it("tool() returns only after the publish's index_enqueue log is out", async () => {
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const r = await tool(client, "publish_artifact", {
      title: "Drain",
      format: "markdown",
      content: "# Drain\n",
    });
    expect(r.isError).toBeFalsy();
    // Synchronous: no waitFor. The log must already be there.
    expect(
      logs.mock.calls.some(([l]) =>
        String(l).includes('"evt":"index_enqueue"'),
      ),
    ).toBe(true);
  } finally {
    logs.mockRestore();
  }
});

it("settle() on a client with nothing pending returns", async () => {
  await settle(client);
});
