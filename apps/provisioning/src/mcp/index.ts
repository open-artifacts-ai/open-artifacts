import type { Env } from "../env.js";

// The admin MCP transport adapter (design v7 9A.2, 9A.4), W13a: body cap,
// authn (9A.3.3), JSON-RPC, then invokeRoute(..., { kind: "mcp", tool }).
// This directory imports only routes/invoke.ts, auth/ and the tool table
// (test/node/layout.test.ts).

const NOT_IMPLEMENTED = JSON.stringify({
  error: { code: "not_implemented", message: "Not implemented yet." },
});

export async function handleMcp(
  req: Request,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  if (req.method !== "POST")
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  return new Response(NOT_IMPLEMENTED, {
    status: 501,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
