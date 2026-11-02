import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { ADMIN_TOOLS, toolInput, toolOutput } from "@oa/shared/provisioning";
import { fixtureWorld } from "@oa/shared/provisioning/fakes";
import { describe, expect, it } from "vitest";

// Design v7 9A.6 / 14.4 (C1 test): the admin MCP server returns route
// refusals as isError results whose structuredContent is the API envelope,
// not the tool's outputSchema. Pins that SDK 2.3.1 skips outputSchema
// validation on isError results, on the server and in the client.
describe("MCP SDK 2.3.1: outputSchema on isError results", () => {
  const found = ADMIN_TOOLS.find((t) => t.name === "get_world");
  if (!found) throw new Error("get_world missing");
  const world = found;
  const envelope = {
    error: { code: "forbidden", message: "Missing scope installs:read." },
  };

  async function connect(mode: "refuse" | "ok" | "bad") {
    const server = new McpServer({ name: "probe", version: "0.0.0" });
    server.registerTool(
      world.name,
      {
        description: world.description,
        inputSchema: toolInput(world),
        outputSchema: toolOutput(world) as never,
      },
      async () =>
        mode === "refuse"
          ? {
              isError: true,
              content: [
                { type: "text", text: `forbidden: ${envelope.error.message}` },
              ],
              structuredContent: envelope,
            }
          : {
              content: [{ type: "text", text: world.summary(fixtureWorld()) }],
              structuredContent: mode === "ok" ? fixtureWorld() : envelope,
            },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: "probe-client", version: "0.0.0" });
    await client.connect(a);
    return client;
  }

  it("an isError result with the envelope reaches the client unchanged", async () => {
    const client = await connect("refuse");
    await client.listTools();
    const r = await client.callTool({ name: world.name, arguments: {} });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual(envelope);
    await client.close();
  });

  it("a 2xx result is still validated against the derived outputSchema", async () => {
    const client = await connect("ok");
    await client.listTools();
    const r = await client.callTool({ name: world.name, arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual(fixtureWorld());
    await client.close();
  });

  it("control: a 2xx result that breaks the outputSchema is refused", async () => {
    const client = await connect("bad");
    await client.listTools();
    const r = await client
      .callTool({ name: world.name, arguments: {} })
      .catch((e: Error) => ({ isError: true, thrown: e.message }));
    expect(r.isError).toBe(true);
    await client.close();
  });
});
