import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { connectDaemon } from "@oa/bus-ipc";
import { CodexProxy } from "./codex-proxy.ts";
import { busHome } from "./session.ts";
import { daemonSocketPath, socketDirProblem } from "./socket-path.ts";

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
 * The local stdio server Codex runs in place of the instance's remote entry
 * (#1856): same tools, forwarded to `<instance>/mcp`. The token comes from the
 * environment variable `tokenEnv` names (Codex passes it on by name) or from
 * `tokenFile`; it is never printed. It listens on nothing, and does not list
 * the `codex/connection-lease` capability, so Codex keeps one process per chat.
 */
export async function startCodexProxy(opts: {
  instance: string;
  tokenEnv?: string;
  tokenFile?: string;
}): Promise<void> {
  const home = busHome();
  const socket = daemonSocketPath(home);
  const proxy = new CodexProxy({
    instance: opts.instance,
    token: () =>
      (opts.tokenEnv
        ? process.env[opts.tokenEnv]?.trim() || undefined
        : undefined) ?? readTokenFile(opts.tokenFile),
    connect: (hello) => {
      // A short socket folder another user could reach is never dialed.
      const problem = socketDirProblem(home);
      return problem
        ? Promise.reject(new Error(problem))
        : connectDaemon({ path: socket, hello });
    },
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
