import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  daemonSocketPath,
  socketDirProblem,
} from "@oa/bus-adapter-claude-code";
import { connectDaemon } from "@oa/bus-ipc";
import { serverOptions } from "./rules.ts";
import { opencodeApi, rootSession } from "./session.ts";
import { handleToolCall, TOOLS } from "./tools.ts";

/** Builds the OpenCode oa_bus MCP server with tools and initialize instructions wired. */
export function createServer(home: string): Server {
  const socket = daemonSocketPath(home);
  const server = new Server(
    { name: "oa_bus", version: "0.1.0" },
    serverOptions(home),
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...TOOLS],
  }));
  server.setRequestHandler(CallToolRequestSchema, (req, extra) =>
    handleToolCall({
      name: req.params.name,
      args: (req.params.arguments ?? {}) as Record<string, unknown>,
      meta: req.params._meta as Record<string, unknown> | undefined,
      connect: (hello) => {
        // A short socket folder another user could reach is never dialed.
        const problem = socketDirProblem(home);
        return problem
          ? Promise.reject(new Error(problem))
          : connectDaemon({ path: socket, hello });
      },
      resolve: (id) => rootSession(id, { api: opencodeApi }),
      signal: extra.signal,
    }),
  );
  return server;
}
