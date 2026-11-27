import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { daemonLinkProof, systemTool } from "@oa/bus-ipc";
import { AgyProxy } from "./agy-proxy.ts";
import { readTokenFile } from "./codex-proxy-main.ts";
import { busHome } from "./session.ts";
import { daemonSocketPath, socketDirProblem } from "./socket-path.ts";

export type Proc = (pid: number) => { ppid: number; name: string } | null;

/** `/proc` on Linux; `ps` elsewhere. The name is the executable's base name. */
export const readProc: Proc = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 1).split(/\s+/)[2]);
    const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    return { ppid, name: comm };
  } catch {}
  try {
    const out = execFileSync(
      systemTool("ps"),
      ["-o", "ppid=,comm=", "-p", String(pid)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const m = /^(\d+)\s+(.+)$/.exec(out);
    return m ? { ppid: Number(m[1]), name: basename(m[2] as string) } : null;
  } catch {
    return null;
  }
};

/**
 * The first process from `from` up (itself included) that runs `agy`. agy
 * starts its MCP servers itself (S0: the parent is the agy pid); a wrapper
 * in between (a shell shim) is walked past.
 */
export function findAgy(from: number, proc: Proc): number | undefined {
  let pid = from;
  for (let i = 0; i < 8 && pid > 1; i += 1) {
    const p = proc(pid);
    if (!p) return undefined;
    if (p.name === "agy") return pid;
    pid = p.ppid;
  }
  return undefined;
}

/**
 * agy S5: the stdio server Antigravity runs in place of the instance's http
 * entry: same tools, forwarded to `<instance>/mcp`, each call with its
 * conversation's link proof. The token comes from the environment variable
 * `tokenEnv` names (install moved the entry's header there, in the same file)
 * or from `tokenFile`; it is never printed. It listens on nothing.
 */
export async function startAgyProxy(opts: {
  instance: string;
  instanceName?: string;
  tokenEnv?: string;
  tokenFile?: string;
}): Promise<void> {
  const home = busHome();
  const socket = daemonSocketPath(home);
  let agy: number | undefined;
  const proxy = new AgyProxy({
    instance: opts.instance,
    ...(opts.instanceName ? { instanceName: opts.instanceName } : {}),
    token: () =>
      (opts.tokenEnv
        ? process.env[opts.tokenEnv]?.trim() || undefined
        : undefined) ?? readTokenFile(opts.tokenFile),
    // The agy process never changes under this server: found once.
    agyPid: () => {
      agy ??= findAgy(process.ppid, readProc);
      return agy;
    },
    link: (req) => {
      // A short socket folder another user could reach is never dialed.
      const problem = socketDirProblem(home);
      return problem
        ? Promise.reject(new Error(problem))
        : daemonLinkProof({ path: socket, ...req });
    },
  });
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
