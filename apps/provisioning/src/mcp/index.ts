import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "../env.js";
import { chargeTransport } from "../routes/invoke.js";
import { mcpPrincipal, mcpUnauthorized, type OAuthPrincipal } from "./auth.js";
import { createAdminServer } from "./server.js";

// The admin MCP transport adapter (design v7 9A.2, 9A.4): after the app's
// host policy and pre-authn IP limit, body cap -> authn (9A.3.3) -> JSON-RPC
// (a fresh stateless server per request) -> invokeRoute(..., { kind: "mcp",
// tool }) per tools/call. CSRF and Origin-before-authn do not apply: no
// cookie is read on the api host; the SDK refuses a foreign browser Origin.
// This directory imports only routes/invoke.ts, auth/ and the tool table
// (test/node/layout.test.ts).

/** The API's 16 KiB body cap plus the JSON-RPC envelope (9A.2). */
export const MCP_BODY_CAP = 32 * 1024;

export type McpDeps = { oauthPrincipal?: OAuthPrincipal };

/** Over the cap, before parse: HTTP 413, JSON-RPC -32000 (9A.6). */
const tooLarge = () =>
  Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Request too large" },
      id: null,
    },
    { status: 413 },
  );

/**
 * Reads the body once with a running count: 413 on a declared size over the
 * cap before anything is read, or as soon as the stream passes it. Returns a
 * Request on the bounded buffer, and the buffer for the method peek.
 */
async function capBody(
  req: Request,
): Promise<{ req: Request; buf: Uint8Array } | Response> {
  if (Number(req.headers.get("content-length") ?? 0) > MCP_BODY_CAP)
    return tooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MCP_BODY_CAP) {
        await reader.cancel().catch(() => {});
        return tooLarge();
      }
      chunks.push(value);
    }
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  const headers = new Headers(req.headers);
  headers.set("content-length", String(size));
  return {
    req: new Request(req.url, { method: req.method, headers, body: buf }),
    buf,
  };
}

/**
 * True unless every JSON-RPC message is a tools/call, which invokeRoute
 * charges itself (9A.7). Unparsable bodies are charged too; the SDK answers
 * them.
 */
function chargesTransport(buf: Uint8Array): boolean {
  let msg: unknown;
  try {
    msg = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return true;
  }
  const all = Array.isArray(msg) ? msg : [msg];
  return (
    all.length === 0 ||
    all.some((m) => (m as { method?: unknown } | null)?.method !== "tools/call")
  );
}

export async function handleMcp(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  deps: McpDeps = {},
): Promise<Response> {
  if (req.method !== "POST")
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  const capped = await capBody(req);
  if (capped instanceof Response) return capped;
  const principal = await mcpPrincipal(capped.req, env, deps.oauthPrincipal);
  if (!principal) return mcpUnauthorized(env);
  // A 429 or 503 here is the API envelope (the app's guard renders it).
  if (chargesTransport(capped.buf)) await chargeTransport(env, principal);
  return createMcpHandler(() => createAdminServer(env, ctx, principal), {
    route: "/mcp",
    corsOptions: false,
    allowedOriginHostnames: [`api.${env.APP_DOMAIN}`],
    maxRequestBodySize: MCP_BODY_CAP,
  }).fetch(capped.req, {
    // The bearer never reaches the SDK, so no handler can log or echo it.
    authInfo: { token: "", clientId: principal.actorKey, scopes: [] },
  });
}
