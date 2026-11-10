// The /mcp entry (PAT and OAuth): what runs before and around the tool
// handlers. A tool error is already answered by `guard` (server.ts); a throw
// anywhere else at the entry (body cap, bus link, transport) was an uncaught
// Worker exception (Cloudflare 1101). These two helpers make it a logged,
// answered 500 and keep the bus link optional.

import { LINK_PROOF_HEADER } from "@oa/bus-protocol";
import type { Env } from "../env.js";
import { ApiError, errorJson, toErrorResponse } from "../http/errors.js";
import { logError, redact } from "../log.js";
import { linkRequest } from "../services/bus.js";

/** The same body the API gives for an unexpected error, so a client knows to retry. */
const INTERNAL = () => errorJson(500, "internal", "Internal error");

/** The stack frames only: the first lines repeat the message, which the log caps and redacts on its own. */
const frames = (stack: string) =>
  stack
    .split("\n")
    .filter((l) => /^\s*at\s/.test(l))
    .join("\n");

/**
 * Runs the /mcp entry; a throw is logged (`mcp_entry_failed`: the error's
 * name, redacted message, the stack frames, the method; never the token, a link
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
          ? redact(frames(e.stack)).slice(0, 1500)
          : undefined,
    });
    // A deliberate refusal keeps its own status and code.
    return e instanceof ApiError ? toErrorResponse(e) : INTERNAL();
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
    // Never forward the proof header, whatever the method.
    const headers = new Headers(req.headers);
    headers.delete(LINK_PROOF_HEADER);
    if (req.method !== "POST") return { req: new Request(req, { headers }) };
    // Keep content-type and accept so the handler refuses the body properly
    // (not a vague 406/415).
    const kept = new Headers();
    for (const h of ["content-type", "accept"]) {
      const v = headers.get(h);
      if (v !== null) kept.set(h, v);
    }
    return {
      req: new Request(req.url, {
        method: req.method,
        headers: kept,
        body: "{",
      }),
    };
  }
}
