import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import {
  ADMIN_TOOLS,
  type AdminToolDef,
  LIFECYCLE_DOC_URI,
  lifecycleDoc,
  MCP_PROMPTS,
  MCP_SERVER,
  mcpInstructions,
  ROUTES,
  toolInput,
  toolOutput,
  toolText,
} from "@oa/shared/provisioning";
import type { z } from "zod";
import type { Env } from "../env.js";
import type { Principal } from "../principal.js";
import { invokeRoute, type RouteInput, refusalOf } from "../routes/invoke.js";

// The admin MCP server (design v7 9A.5): one tool per ADMIN_TOOLS row, each
// a call of its route through invokeRoute (same limit, authz row, zod,
// policy, business and audit as /v1). No tool has logic of its own.

/** The provisioning app has no release version of its own yet. */
export const SERVER_VERSION = "0.0.0";
/** 4.7's RL_PV_READ / RL_PV_WRITE window: the retry hint of a 429 tool result. */
const RATE_WINDOW_S = 60;
/** The header a 3.1 replay carries (W4 services/jobs.ts REPLAY_HEADER). */
const REPLAY_HEADER = "oa-idempotent-replay";
const CLIENT_VERSION_RE = /^[A-Za-z0-9._-]{1,20}$/;

/** MCP clientInfo.version for audit detail only (9A.3.3); never authz. */
export const clientVersionOf = (v: unknown): string | null =>
  typeof v === "string" && CLIENT_VERSION_RE.test(v) ? v : null;

/**
 * A tool's arguments as the route's input: the table's `defaults` merged
 * first, then each field to the part of the route that declares it. Query
 * values go as strings, exactly as /v1 reads them from the URL.
 */
export function routeInput(
  t: AdminToolDef,
  args: Record<string, unknown>,
): RouteInput {
  const def = ROUTES[t.route];
  const merged: Record<string, unknown> = { ...t.defaults, ...args };
  const params: Record<string, string> = {};
  const query: Record<string, string> = {};
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined) continue;
    if (k in def.params.shape) params[k] = String(v);
    else if (k in def.query.shape) query[k] = String(v);
    else body[k] = v;
  }
  return def.method === "GET" ? { params, query } : { params, query, body };
}

const text = (s: string) => [{ type: "text" as const, text: s }];

/**
 * A refusal as a tool result (9A.6): isError, "<code>: <message>", the API
 * envelope as structuredContent. Anything else is `internal`, logged as a
 * category only.
 */
export function errorResult(e: unknown): CallToolResult {
  const r = refusalOf(e);
  if (!r) {
    console.error("mcp_tool_error", e instanceof Error ? e.name : typeof e);
    return {
      isError: true,
      content: text("internal: Internal error"),
      structuredContent: {
        error: { code: "internal", message: "Internal error" },
      },
    };
  }
  const details =
    r.code === "rate_limited"
      ? {
          ...(r.details as object | undefined),
          retryAfter: RATE_WINDOW_S,
        }
      : r.details;
  return {
    isError: true,
    content: text(`${r.code}: ${r.message}`),
    structuredContent: {
      error: {
        code: r.code,
        message: r.message,
        ...(details === undefined ? {} : { details }),
      },
    },
  };
}

const GET_INSTALL_INPUT = toolInput({ route: "R3" });

export function createAdminServer(
  env: Env,
  ctx: ExecutionContext,
  principal: Principal,
): McpServer {
  const server = new McpServer(
    {
      name: MCP_SERVER.name,
      title: MCP_SERVER.title(env.OA_ENV),
      version: SERVER_VERSION,
    },
    { instructions: mcpInstructions(env.OA_ENV, env.APP_DOMAIN) },
  );
  const clientVersion = () =>
    clientVersionOf(server.server.getClientVersion()?.version);

  for (const t of ADMIN_TOOLS)
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: toolInput(t),
        outputSchema: toolOutput(t) as z.ZodObject,
        annotations: t.annotations,
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        let r: Awaited<ReturnType<typeof invokeRoute>>;
        try {
          r = await invokeRoute(
            env,
            ctx,
            principal,
            t.route,
            routeInput(t, args),
            {
              kind: "mcp",
              tool: t.name,
              clientVersion: clientVersion(),
            },
          );
        } catch (e) {
          return errorResult(e);
        }
        const replayed = r.headers[REPLAY_HEADER] === "1";
        return {
          content: text(toolText(t, r.body, replayed)),
          structuredContent: r.body as Record<string, unknown>,
          ...(replayed ? { _meta: { "oa/replayed": true } } : {}),
        };
      },
    );

  server.registerResource(
    "lifecycle",
    LIFECYCLE_DOC_URI,
    {
      title: "Install lifecycle",
      description:
        "States and precedence, transitions, job steps, error codes, scopes and the polling rule.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: lifecycleDoc() },
      ],
    }),
  );

  for (const p of MCP_PROMPTS) {
    const prompt = (id?: string) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: id === undefined ? p.text : `${p.text}\n\nInstall: ${id}`,
          },
        },
      ],
    });
    if (p.arguments.length === 0)
      server.registerPrompt(p.name, { description: p.text }, () => prompt());
    else
      server.registerPrompt(
        p.name,
        {
          description: p.text,
          // get_install's derived input: { id: InstallId }, strict.
          argsSchema: GET_INSTALL_INPUT,
        },
        ({ id }) => prompt(String(id)),
      );
  }
  return server;
}
