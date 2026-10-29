import { MCP_PATH, normalizeHost as normHost } from "@oa/shared";
import { app } from "./app.js";
import { canConnect } from "./auth/agents.js";
import { withBrokerProps } from "./auth/broker-transport.js";
import { withCred } from "./auth/cred.js";
import { verifyPat } from "./auth/pat.js";
import { contentApp } from "./content/app.js";
import { scheduled } from "./cron.js";
import type { Env } from "./env.js";
import { appHostOpts, withSecurityHeaders } from "./http/middleware.js";
import { serveAppHost } from "./mcp/oauth.js";
import {
  capMcpBody,
  createServer,
  mcpHandler,
  mcpUnauthorized,
} from "./mcp/server.js";
import { withMcpSession } from "./mcp/session.js";
import { type AgentAttr, viaKey } from "./services/agent-usage.js";
import { getUserWithEpoch } from "./services/users.js";

export { DirectorySync } from "./directory/sync-do.js";
export type { Env } from "./env.js";
export { ArtifactRuntime } from "./runtime/do.js";
export { UserPresence } from "./runtime/presence.js";

// URL.hostname keeps the brackets for IPv6: "[::1]", never "::1".
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * True for a host this Worker must not answer. It answers APP_HOST and
 * CONTENT_HOST only (route policy: a request whose host is neither gets a
 * plain 404, before any auth or D1). Under a WfP wildcard route this is what
 * keeps another install's hostname from reaching this one.
 *
 * Every install, hosted or self-hosted: setup always renders both hosts (it
 * refuses an empty, placeholder or duplicate pair), so a missing APP_HOST is
 * a broken config and fails closed; a missing CONTENT_HOST matches nothing. Dev (ENVIRONMENT=dev) also answers localhost/127.0.0.1/[::1], so
 * `wrangler dev` and the dev dashboard keep working. X-Forwarded-Host is
 * never consulted (URL.hostname only).
 */
function isForeignHost(env: Env, hostname: string): boolean {
  const appHost = normHost(env.APP_HOST ?? "");
  if (!appHost) return true;
  const host = normHost(hostname);
  if (host === appHost) return false;
  return !(env.ENVIRONMENT === "dev" && LOCAL_HOSTS.has(host));
}

const PAT_BEARER = /^\s*Bearer\s+(oa_pat_\S*)\s*$/i;

/** /mcp with `Authorization: Bearer oa_pat_…`: the token's user, attributed to its label. */
async function mcpWithPat(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  token: string,
): Promise<Response> {
  const pat = await verifyPat(env, token, ctx);
  const row = pat ? await getUserWithEpoch(env, pat.userId) : null;
  if (!pat || !row) return mcpUnauthorized(env);
  const { user, sessionEpoch } = row;
  // Members only, never a capped caller (a guest, a restricted member): the
  // same rule as an OAuth grant (canConnect).
  if (!canConnect(user))
    return mcpUnauthorized(env, "Only members can connect agents");
  const capped = await capMcpBody(req, env);
  if (capped instanceof Response) return capped;
  const agent: AgentAttr = {
    name: pat.label,
    version: null,
    via: { kind: "token", id: pat.tokenId },
  };
  const connection = viaKey({ kind: "token", id: pat.tokenId });
  // Audit rows from these tools name the PAT (by id, never its text).
  return withCred({ kind: "pat", id: pat.tokenId }, () =>
    withMcpSession(capped, env, user.id, (session) =>
      mcpHandler(env, () =>
        createServer({
          env,
          user,
          sessionEpoch,
          agent,
          connection,
          session,
          exec: ctx,
        }),
      ).fetch(capped, {
        // token is deliberately empty: tools never need it, and the SDK must
        // not be able to log or echo the PAT. clientId names the token row.
        authInfo: { token: "", clientId: `pat:${pat.tokenId}`, scopes: [] },
      }),
    ),
  );
}

export default {
  fetch(req, env, ctx) {
    // The platform's broker capabilities (ctx.props) for this invocation.
    return withBrokerProps(ctx, () => serve(req, env, ctx));
  },
  scheduled,
} satisfies ExportedHandler<Env>;

async function serve(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // URL.hostname only: port stripped; X-Forwarded-Host is ignored.
  const url = new URL(req.url);
  if (normHost(url.hostname) === normHost(env.CONTENT_HOST ?? ""))
    return contentApp.fetch(req, env, ctx);
  // Another install's hostname (WfP wildcard) or a stray alias: 404 before
  // auth, OAuth, the route policy or D1. Plain body, no other headers.
  if (isForeignHost(env, url.hostname))
    return new Response("Not found", { status: 404 });
  const pat =
    url.pathname === MCP_PATH
      ? PAT_BEARER.exec(req.headers.get("authorization") ?? "")
      : null;
  // PATs at /mcp; everything else through the OAuth provider: OAuth bearer
  // at /mcp, its token/register/metadata endpoints, then the app.
  const res = pat?.[1]
    ? await mcpWithPat(req, env, ctx, pat[1])
    : await serveAppHost(req, env, ctx, app);
  return withSecurityHeaders(res, appHostOpts(env, req.method, url.pathname));
}
