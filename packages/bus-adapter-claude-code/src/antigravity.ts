import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./tools.ts";

/** What a tool call says until Antigravity can join the bus (agy S2, S3). */
export const AGY_NOT_YET =
  "Antigravity can't use the bus yet. A later oa-bus update turns it on.";

/**
 * Antigravity (agy) runs `oa-bus mcp antigravity` from its mcp_config.json
 * (agy S1b). Until its sessions can join (S2) and get messages (S3), this
 * server lists the bus tools and answers every call with AGY_NOT_YET. It
 * never dials the daemon, so no agent of a kind the instances don't know yet
 * reaches a hub.
 */
export function antigravityServer(): Server {
  const server = new Server(
    { name: "oa_bus", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...TOOLS],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: AGY_NOT_YET }],
    isError: true,
  }));
  return server;
}
