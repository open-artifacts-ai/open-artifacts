import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BUS_CMD, connectDaemon, type DaemonClient } from "@oa/bus-ipc";
import {
  ancestorChain,
  busHome,
  claudeProcStartOf,
  claudeSessionsDir,
  findSession,
  sessionHello,
} from "./session.ts";
import { daemonSocketPath, socketDirProblem } from "./socket-path.ts";
import { callTool, TOOLS } from "./tools.ts";

const SESSIONS = claudeSessionsDir();
const HOME = busHome();
const SOCKET = daemonSocketPath(HOME);

/** One connection per tool call: the daemon attests the session behind this process. */
async function connect(): Promise<DaemonClient | null> {
  try {
    const session = findSession(process.pid, {
      sessionsDir: SESSIONS,
      ancestors: ancestorChain,
      procStart: claudeProcStartOf,
    });
    // A short socket folder another user could reach is never dialed.
    if (!session || socketDirProblem(HOME)) return null;
    return await connectDaemon({
      path: SOCKET,
      hello: sessionHello(session, process.pid, process.cwd()),
    });
  } catch {
    return null;
  }
}

const server = new Server(
  { name: "oa_bus", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...TOOLS],
}));
server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const client = await connect();
  if (!client) {
    return {
      content: [
        {
          type: "text",
          text: `oa-bus: no Claude session or daemon found. Run \`${BUS_CMD} install\`.`,
        },
      ],
      isError: true,
    };
  }
  try {
    return await callTool(
      req.params.name,
      (req.params.arguments ?? {}) as Record<string, unknown>,
      client,
      extra.signal,
    );
  } finally {
    client.close();
  }
});

await server.connect(new StdioServerTransport());
