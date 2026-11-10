// The /mcp entry (PAT and OAuth): what runs before and around the tool
// handlers. A tool error is already answered by `guard` (server.ts); a throw
// anywhere else at the entry (body cap, bus link, transport) was an uncaught
// Worker exception (Cloudflare 1101). These two helpers make it a logged,
// answered 500 and keep the bus link optional.

import type { Env } from "../env.js";
import { errorJson } from "../http/errors.js";
import { logError, redact } from "../log.js";
import { linkRequest } from "../services/bus.js";

/** The same body the API gives for an unexpected error, so a client knows to retry. */
const INTERNAL = () => errorJson(500, "internal", "Internal error");

/**
 * Runs the /mcp entry; a throw is logged (`mcp_entry_failed`: the error's
 * name, redacted message and stack, the method; never the token, a link
 * proof or the body) and answered with the API's internal-error JSON.
 */
export async function guardMcpEntry(
  req: Request,
  run: () => Promise<Response>,
): Promise<Response> {
  try {
    return await run();
  } catch (e) {
    logError("mcp_entry_failed", e, {
      method: req.method,
      stack:
        e instanceof Error && e.stack
          ? redact(e.stack).slice(0, 1500)
          : undefined,
    });
    return INTERNAL();
  }
}

/**
 * `linkRequest`, but a failure is not fatal: it is logged and the request is
 * served unlinked (an unlinked caller must still work). Like linkRequest's
 * own failure path, a POST body is never forwarded as it was, because the
 * link step may have been the one to see a proof argument in it: the handler
 * gets an unparseable body and refuses it.
 */
export async function linkOrUnlinked(
  env: Env,
  userId: string,
  req: Request,
): ReturnType<typeof linkRequest> {
  try {
    return await linkRequest(env, userId, req);
  } catch (e) {
    logError("mcp_link_failed", e);
    return {
      req:
        req.method === "POST"
          ? new Request(req.url, { method: req.method, body: "{" })
          : req,
    };
  }
}
