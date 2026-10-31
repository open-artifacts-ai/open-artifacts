import { originValidationResponse } from "@modelcontextprotocol/server";
import {
  ADMIN_TOOLS,
  type AdminToolName,
  toolInput,
} from "@oa/shared/provisioning";
import { createMcpHandler } from "agents/mcp/server";
import { chargeTransport, countUnauthenticated } from "../auth/mcp-gate.js";
import type { Env } from "../env.js";
import { mcpPrincipal, mcpUnauthorized, type OAuthPrincipal } from "./auth.js";
import { createAdminServer } from "./server.js";

// The admin MCP transport adapter (design v7 9A.2, 9A.4): after the app's
// host policy and pre-authn IP limit, body cap -> authn (9A.3.3) -> JSON-RPC
// (a fresh stateless server per request) -> invokeRoute(..., { kind: "mcp",
// tool }) per tools/call. CSRF does not apply: no cookie is read on the api
// host. A foreign browser Origin is 403 first, before the body is read.
// This directory imports only routes/invoke.ts, auth/ (the charge and the
// refusal count: auth/mcp-gate.ts) and the tool table (test/node/layout.test.ts).

/** The API's 16 KiB body cap plus the JSON-RPC envelope (9A.2). */
export const MCP_BODY_CAP = 32 * 1024;

export type McpDeps = { oauthPrincipal?: OAuthPrincipal };

const allowedOrigins = (env: Pick<Env, "APP_DOMAIN">) => [
  `api.${env.APP_DOMAIN}`,
];

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
): Promise<{ req: Request; buf: Uint8Array<ArrayBuffer> } | Response> {
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

const TOOL_INPUTS = new Map(ADMIN_TOOLS.map((t) => [t.name, toolInput(t)]));

type RpcPeek = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown; arguments?: unknown } | null;
};

/** True when the SDK will run this tools/call's handler, so invokeRoute charges it. */
function reachesHandler(m: RpcPeek): boolean {
  // A tools/call notification (no id) is dropped, never handled.
  if (m.jsonrpc !== "2.0") return false;
  if (typeof m.id !== "string" && typeof m.id !== "number") return false;
  const schema =
    typeof m.params?.name === "string"
      ? TOOL_INPUTS.get(m.params.name as AdminToolName)
      : undefined;
  return schema?.safeParse(m.params?.arguments ?? {}).success === true;
}

/**
 * The RL_PV_READ charges the adapter owes before dispatch (9A.7): one for
 * the request's other messages (initialize, tools/list, resources/*,
 * prompts/*, ping, notifications), and one for each tools/call the SDK
 * refuses before its handler (an unknown tool, input failing the derived
 * schema), which never reaches invokeRoute. A tools/call that reaches its
 * handler is charged inside invokeRoute. An unparsable or empty body is one
 * charge; the SDK answers it. A body of only valid tools/calls is 0 here,
 * and handleMcp charges once more if the SDK then refuses the whole POST.
 */
export function transportCharges(buf: Uint8Array): number {
  let msg: unknown;
  try {
    msg = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return 1;
  }
  const all = Array.isArray(msg) ? msg : [msg];
  if (all.length === 0) return 1;
  let other = false;
  let refused = 0;
  for (const raw of all) {
    const m = (raw !== null && typeof raw === "object" ? raw : {}) as RpcPeek;
    if (m.method !== "tools/call") other = true;
    else if (!reachesHandler(m)) refused++;
  }
  return (other ? 1 : 0) + refused;
}

export async function handleMcp(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  deps: McpDeps = {},
): Promise<Response> {
  if (req.method !== "POST")
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  // A foreign browser Origin is 403 before the body, authn or a charge (9A.2).
  const foreign = originValidationResponse(req, allowedOrigins(env));
  if (foreign) return foreign;
  const capped = await capBody(req);
  if (capped instanceof Response) return capped;
  const principal = await mcpPrincipal(capped.req, env, deps.oauthPrincipal);
  if (!principal) {
    // Counted in audit_refusals, bucket auth, as /v1 counts it (4.9).
    await countUnauthenticated(env, req);
    return mcpUnauthorized(env);
  }
  // A 429 or 503 here is the API envelope (the app's guard renders it).
  const charges = transportCharges(capped.buf);
  for (let n = charges; n > 0; n--) await chargeTransport(env, principal);
  // The bearer never reaches the SDK, so no handler can log or echo it:
  // neither in authInfo nor in the request it hands them (requestInfo).
  const headers = new Headers(capped.req.headers);
  headers.delete("authorization");
  const res = await createMcpHandler(
    () => createAdminServer(env, ctx, principal),
    {
      route: "/mcp",
      corsOptions: false,
      allowedOriginHostnames: allowedOrigins(env),
      maxRequestBodySize: MCP_BODY_CAP,
    },
  ).fetch(
    new Request(capped.req.url, {
      method: "POST",
      headers,
      body: capped.buf,
    }),
    { authInfo: { token: "", clientId: principal.actorKey, scopes: [] } },
  );
  // The SDK refused the whole POST before any handler (406 Accept, 415
  // Content-Type, 400 protocol version, batch size or JSON-RPC shape), so
  // invokeRoute charged nothing: one charge, so no authenticated POST is free.
  // Nothing ran, so its 429 replaces the SDK's answer.
  if (charges === 0 && res.status >= 400)
    await chargeTransport(env, principal).catch(async (e: unknown) => {
      await res.body?.cancel().catch(() => {});
      throw e;
    });
  return res;
}
