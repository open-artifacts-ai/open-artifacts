import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  busHome,
  daemonSocketPath,
  socketDirProblem,
} from "@oa/bus-adapter-claude-code";
import { connectDaemon } from "@oa/bus-ipc";
import { opencodeApi, rootSession } from "./session.ts";
import { handleToolCall, TOOLS } from "./tools.ts";

const HOME = busHome();
const SOCKET = daemonSocketPath(HOME);

const server = new Server(
  { name: "oa_bus", version: "0.1.0" },
  { capabilities: { tools: {} } },
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
      const problem = socketDirProblem(HOME);
      return problem
        ? Promise.reject(new Error(problem))
        : connectDaemon({ path: SOCKET, hello });
    },
    resolve: (id) => rootSession(id, { api: opencodeApi }),
    signal: extra.signal,
  }),
);

await server.connect(new StdioServerTransport());
