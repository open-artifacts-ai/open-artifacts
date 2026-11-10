import { readFileSync } from "node:fs";
import { homedir } from "node:os";
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
import { OpenCodeProxy } from "./proxy.ts";
import { opencodeApi, rootSession } from "./session.ts";

/** The token file's text, trimmed; undefined when it cannot be read or is empty. */
export function readTokenFile(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    const p = path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
    return readFileSync(p, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The local stdio server OpenCode runs in place of the instance's remote
 * entry (#1856): same tools, forwarded to `<instance>/mcp`. It listens on
 * nothing; OpenCode owns its stdin and stdout.
 */
export async function startProxy(opts: {
  instance: string;
  tokenFile?: string;
}): Promise<void> {
  const home = busHome();
  const socket = daemonSocketPath(home);
  const proxy = new OpenCodeProxy({
    instance: opts.instance,
    token: () => readTokenFile(opts.tokenFile),
    connect: (hello) => {
      // A short socket folder another user could reach is never dialed.
      const problem = socketDirProblem(home);
      return problem
        ? Promise.reject(new Error(problem))
        : connectDaemon({ path: socket, hello });
    },
    resolve: (id) => rootSession(id, { api: opencodeApi }),
  });
  // The instance's own instructions, when it answers in time; tools work without them.
  const instructions = await proxy
    .hello(AbortSignal.timeout(3000))
    .then((h) => h.instructions)
    .catch(() => undefined);
  const server = new Server(
    { name: "open-artifacts", version: "0.1.0" },
    { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) },
  );
  server.setRequestHandler(
    ListToolsRequestSchema,
    async (req, extra) =>
      (await proxy.list(req.params, extra.signal)) as { tools: never[] },
  );
  server.setRequestHandler(
    CallToolRequestSchema,
    async (req, extra) =>
      (await proxy.call(req.params, extra.signal)) as { content: never[] },
  );
  await server.connect(new StdioServerTransport());
}
