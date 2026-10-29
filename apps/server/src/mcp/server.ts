import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import {
  dataLimits,
  MCP_PATH,
  type Member,
  mcpBodyLimit,
  mcpTooLargeMessage,
  QUOTA_MESSAGE,
} from "@oa/shared";
import { createMcpHandler } from "agents/mcp/server";
import { type Caller, callerOf, withAccessCache } from "../auth/authz.js";
import { enforce, TOOL_POLICY } from "../auth/route-policy.js";
import type { Env } from "../env.js";
import {
  ApiError,
  appOrigin,
  errorJson,
  isD1QuotaError,
} from "../http/errors.js";
import { logError } from "../log.js";
import { toRuntimeApiError } from "../runtime/do.js";
import { type AgentAttr, clientVersionOf } from "../services/agent-usage.js";
import { cpuNudge } from "../services/usage.js";
import { VERSION } from "../version.gen.js";
import { INSTRUCTIONS, RUNTIME_DOC_URI } from "./instructions.js";
import { renderSkill, SKILL_DOC_URI, skillUrl } from "./skill.js";
import { registerArtifactTools } from "./tools/artifacts.js";
import { registerDataTools } from "./tools/data.js";

export type McpContext = {
  env: Env;
  user: Member;
  /** The user's session_epoch, read with the user row: download URLs bind it (P3 T11). */
  sessionEpoch: number;
  /**
   * PAT: { label, null }. OAuth: { clientName, null } plus `clientVersion`.
   * `via` names the token or grant (publish attribution).
   */
  agent: AgentAttr | null;
  /**
   * The connection an agent call came over: `t:<tokenId>` (PAT),
   * `g:<grantId>` (OAuth grant), or `c:<userId>` for an OAuth token with no
   * parseable grant id.
   */
  connection: string;
  /** The verified legacy-era MCP session id (its random part), else null. */
  session: string | null;
  /** For waitUntil work (search indexing after publish). */
  exec?: Pick<ExecutionContext, "waitUntil">;
  /** Fill agent.version from the MCP clientInfo.version (OAuth clients). */
  clientVersion?: boolean;
};

/** What the tool modules get: the context plus the per-call agent ref. */
export type ToolEnv = McpContext & {
  caller: Caller;
  agentNow: () => AgentAttr | null;
};

/** `{ content: [one-line summary], structuredContent }`. */
export function ok(
  text: string,
  structuredContent: Record<string, unknown>,
): CallToolResult {
  return {
    content: [{ type: "text", text: text.replace(/\s*\n\s*/g, " ") }],
    structuredContent,
  };
}

/** ApiError (and DO runtime errors) → `"<code>: <message>"`; D1 quota → QUOTA_MESSAGE. */
export function errorResult(e: unknown): CallToolResult {
  const text = (code: string, message: string) => ({
    isError: true,
    content: [{ type: "text" as const, text: `${code}: ${message}` }],
  });
  const api = e instanceof ApiError ? e : toRuntimeApiError(e);
  if (api) {
    if (api.code === "quota_exceeded")
      return text("quota_exceeded", QUOTA_MESSAGE);
    return text(api.code, api.message);
  }
  if (isD1QuotaError(e)) return text("quota_exceeded", QUOTA_MESSAGE);
  logError("mcp_tool_error", e);
  return text("internal", "Internal error");
}

/**
 * Runs a tool body, mapping thrown errors to an isError result. Appends the
 * CPU-limit nudge as its own text item (from the per-isolate usage memo; no fetch).
 */
export async function guard(
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  let r: CallToolResult;
  try {
    r = await fn();
  } catch (e) {
    r = errorResult(e);
  }
  const nudge = cpuNudge();
  return nudge
    ? { ...r, content: [...r.content, { type: "text", text: nudge }] }
    : r;
}

export function createServer(ctx: McpContext): McpServer {
  const { plan, docBytes } = dataLimits(ctx.env);
  const instructions = INSTRUCTIONS(plan, skillUrl(ctx.env), docBytes);
  const server = new McpServer(
    { name: "open-artifacts", version: VERSION },
    { instructions },
  );
  const agentNow = (): AgentAttr | null => {
    if (!ctx.agent || !ctx.clientVersion) return ctx.agent;
    return {
      ...ctx.agent,
      version: clientVersionOf(server.server.getClientVersion()?.version),
    };
  };
  const t: ToolEnv = {
    ...ctx,
    caller: callerOf(ctx.user),
    agentNow,
  };
  enforceToolPolicy(server, t);
  registerArtifactTools(server, t);
  registerDataTools(server, t);
  server.registerResource(
    "runtime-docs",
    RUNTIME_DOC_URI,
    {
      title: "Open Artifacts guide",
      description:
        "Formats, multi-file publishing, large uploads, capabilities and the window.openArtifacts API.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: instructions,
        },
      ],
    }),
  );
  if (skillUrl(ctx.env))
    server.registerResource(
      "skill",
      SKILL_DOC_URI,
      {
        title: "Open Artifacts skill",
        description:
          "This instance's Agent Skill (also at /skill.md): connecting, every tool with an example, limits, sharing, live data and errors.",
        mimeType: "text/markdown",
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: await renderSkill(ctx.env),
          },
        ],
      }),
    );
  return server;
}

type LimitEnv = Pick<Env, "PLAN" | "DATA_DOC_BYTES" | "DATA_DAILY_WRITES">;

/**
 * The /mcp body cap of the instance's plan (LIMITS.mcpBodyBytesFree/Paid),
 * generic for every tool and checked before any parse.
 */
export const mcpBodyCap = (env: LimitEnv): number => {
  const { plan, docBytes } = dataLimits(env);
  return mcpBodyLimit(plan, docBytes);
};

/**
 * Over the cap: HTTP 413 with a JSON-RPC error, as the SDK's transport answers
 * an oversize body (code -32000, id null: the request was never read). The
 * message gives the create_upload steps and the data-doc limit.
 */
const tooLarge = (env: LimitEnv) => {
  const { plan, docBytes } = dataLimits(env);
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: mcpTooLargeMessage(plan, docBytes) },
      id: null,
    },
    { status: 413 },
  );
};

/**
 * Reads an MCP request body once, into one buffer, with a running cap: 413 on a
 * declared size over mcpBodyCap(env) before anything is read, or as soon as a
 * streamed body passes it (nothing past the cap is buffered). Returns a new
 * Request carrying the buffer, so every era (including the 2025 fallback,
 * which reads the body itself) sees a bounded body and nothing reads the
 * stream twice.
 */
export async function capMcpBody(
  req: Request,
  env: LimitEnv,
): Promise<Request | Response> {
  const cap = mcpBodyCap(env);
  if (Number(req.headers.get("content-length") ?? 0) > cap)
    return tooLarge(env);
  if (!req.body) return req;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      return tooLarge(env);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  const headers = new Headers(req.headers);
  headers.set("content-length", String(size));
  return new Request(req.url, { method: req.method, headers, body: buf });
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;

/**
 * The canonical MCP resource URL (OAuth audience). https, except plain http on a
 * loopback host in dev (OAuth allows http only there).
 */
export function mcpResource(
  env: Pick<Env, "APP_HOST" | "ENVIRONMENT">,
): string {
  const origin =
    env.ENVIRONMENT === "dev" && !LOOPBACK.test(env.APP_HOST)
      ? `https://${env.APP_HOST}`
      : appOrigin(env);
  return `${origin}${MCP_PATH}`;
}

/** RFC 9728 metadata URL for the resource. */
export function mcpResourceMetadataUrl(
  env: Pick<Env, "APP_HOST" | "ENVIRONMENT">,
): string {
  const u = new URL(mcpResource(env));
  return `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`;
}

/** 401 for a bad bearer token at /mcp, pointing at the resource metadata. */
export function mcpUnauthorized(
  env: Pick<Env, "APP_HOST" | "ENVIRONMENT">,
  message = "Invalid or revoked token",
): Response {
  return errorJson(401, "unauthorized", message, undefined, {
    "WWW-Authenticate": `Bearer realm="OAuth", error="invalid_token", resource_metadata="${mcpResourceMetadataUrl(env)}"`,
  });
}

/**
 * Stateless Streamable HTTP handler: a fresh server per request. No CORS (MCP
 * clients aren't browsers); a browser Origin must be the app host.
 */
export function mcpHandler(env: Env, factory: () => McpServer) {
  return createMcpHandler(factory, {
    route: MCP_PATH,
    corsOptions: false,
    allowedOriginHostnames: [new URL(`http://${env.APP_HOST}`).hostname],
    maxRequestBodySize: mcpBodyCap(env),
  });
}

/**
 * Enforces TOOL_POLICY at tools/call dispatch (P3 T5): the SDK runs every
 * tool through executeToolHandler, whichever way it was registered or later
 * updated, so this is the one choke point. A tool without an entry fails;
 * an `artifact` policy authorizes the tool's `id` input (404 otherwise)
 * before the handler, which reuses that access row.
 */
type Dispatch = {
  _registeredTools: Record<string, unknown>;
  executeToolHandler: (tool: unknown, args: unknown, ctx: unknown) => unknown;
};
function enforceToolPolicy(server: McpServer, t: ToolEnv): void {
  const d = server as unknown as Dispatch;
  const run = d.executeToolHandler.bind(server);
  d.executeToolHandler = (tool, args, ctx) => {
    const name = Object.entries(d._registeredTools).find(
      ([, v]) => v === tool,
    )?.[0];
    const p = name === undefined ? undefined : TOOL_POLICY[name];
    return withAccessCache(async () => {
      try {
        if (!p)
          throw new Error(`MCP tool ${name ?? "?"} has no TOOL_POLICY entry`);
        const id = (args as { id?: unknown } | undefined)?.id;
        await enforce(p, t.caller, t.env, () =>
          typeof id === "string" ? id : "",
        );
      } catch (e) {
        return guard(() => Promise.reject(e));
      }
      return run(tool, args, ctx);
    });
  };
}
