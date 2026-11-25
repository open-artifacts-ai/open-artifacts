import { existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  BRIEF_RULES,
  connectDaemon,
  type DaemonClient,
  habitsOff,
} from "@oa/bus-ipc";
import { connectOutcome, noSessionMessage } from "./connect.ts";
import {
  ancestorChain,
  busHome,
  claudeProcStartOf,
  claudeSessionsDir,
  hasClaudeAncestor,
  lookupSession,
  sessionHello,
} from "./session.ts";
import { daemonSocketPath, socketDirProblem } from "./socket-path.ts";
import { callTool, TOOLS } from "./tools.ts";

const SESSIONS = claudeSessionsDir();

/**
 * One connection per tool call: the daemon attests the session behind this
 * process. Home and socket path are resolved per call, never cached, so a
 * daemon that restarted (even elsewhere) is found (#2364).
 */
const connect = () => {
  const HOME = busHome();
  const SOCKET = daemonSocketPath(HOME);
  return connectOutcome<DaemonClient>({
    findSession: () =>
      lookupSession(process.pid, {
        sessionsDir: SESSIONS,
        ancestors: ancestorChain,
        procStart: claudeProcStartOf,
      }),
    // A short socket folder another user could reach is never dialed.
    socketDirProblem: () => socketDirProblem(HOME),
    socketExists: () => existsSync(SOCKET),
    connect: (session) =>
      connectDaemon({
        path: SOCKET,
        hello: sessionHello(session, process.pid, process.cwd()),
      }),
  });
};

/**
 * #3043: the habits this session is told, in the initialize result (the SDK
 * sends `instructions` once, with the handshake). The text is the module the
 * daemon serves too, so an adapter and a daemon of one version cannot
 * disagree; the opt-out is the same install.json flag the daemon reads, so an
 * opted-out install gets nothing here either. No extra daemon dial: a session
 * that never calls a tool still gets its rules.
 */
const rules = habitsOff(busHome()) ? null : BRIEF_RULES;
const server = new Server(
  { name: "oa_bus", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    ...(rules === null ? {} : { instructions: rules }),
  },
);
/** Checked at call time, never at startup: Claude may write its session file after spawning this server. */
const underClaude = (): boolean => {
  try {
    return hasClaudeAncestor(process.pid, {
      sessionsDir: SESSIONS,
      ancestors: ancestorChain,
    });
  } catch {
    return false;
  }
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...TOOLS],
}));
server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const out = await connect();
  if (out.kind !== "ok") {
    const text = noSessionMessage(out, underClaude());
    return { content: [{ type: "text", text }], isError: true };
  }
  const client = out.client;
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
