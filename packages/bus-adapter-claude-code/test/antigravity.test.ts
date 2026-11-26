// agy S1b: the server agy runs lists the bus tools and contacts nothing.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { AGY_NOT_YET, antigravityServer } from "../src/antigravity.ts";
import { TOOLS } from "../src/tools.ts";

async function connected() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await antigravityServer().connect(a);
  const client = new Client({ name: "agy", version: "1.5.13" });
  await client.connect(b);
  return client;
}

describe("oa-bus mcp antigravity", () => {
  it("lists the bus tools", async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    await client.close();
  });

  it("answers every call with a plain note", async () => {
    const client = await connected();
    const r = await client.callTool({ name: "list_agents", arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: "text", text: AGY_NOT_YET }]);
    await client.close();
  });
});
