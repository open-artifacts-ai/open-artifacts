// Provisioning API and admin panel (design v7 2.1): admin.<app> (session
// cookie, SPA, sign-in, MCP consent) and api.<app> (bearer: /v1, /mcp,
// OAuth). It holds no Cloudflare token; the provisioner does (2.5).
import { handle } from "./app.js";
import { sweepOAuthClientsAll } from "./auth/oauth/endpoints.js";
import type { Env } from "./env.js";

export type { Env } from "./env.js";

export default {
  fetch: (req, env, ctx) => handle(req, env, ctx),
  // Hourly (wrangler.jsonc triggers): the MCP client sweep (8.3, 9A.7).
  scheduled: (ctl, env, ctx) => {
    ctx.waitUntil(sweepOAuthClientsAll(env, ctl.scheduledTime).then(() => {}));
  },
} satisfies ExportedHandler<Env>;
