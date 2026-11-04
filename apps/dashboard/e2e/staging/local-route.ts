import type { BrowserContext, Route } from "@playwright/test";

// #1252: on the red-line local pair the Worker builds absolute URLs from
// APP_HOST, which has no port (rl-a.app.localhost), while the pair serves on
// http://rl-a.app.localhost:<port>. The signed upload URL is one: the
// browser's PUT went to port 80 and the dashboard said "Upload failed". In
// local mode only, each browser context sends a port-less request for the
// pair's own hosts (rl-a.app.localhost, rl-a.content.localhost) to the pair's
// port, same protocol. The request still runs; its outcome is the Worker's,
// so a failed upload still fails the spec. Staging installs nothing.

export type RouteTarget = { app: string; local: boolean };

/**
 * The rewrite for `t`: undefined on staging. Local: a port-less http URL on
 * one of the pair's hosts moves to the pair's port; anything else is null
 * (left untouched).
 */
export function localPortRewrite(
  t: RouteTarget,
): ((url: URL) => string | null) | undefined {
  if (!t.local) return undefined;
  const app = new URL(t.app);
  const hosts = new Set([
    app.hostname,
    app.hostname.replace(/^([^.]+)\.app\.localhost$/, "$1.content.localhost"),
  ]);
  return (u) => {
    if (u.protocol !== "http:" || u.port !== "" || !hosts.has(u.hostname))
      return null;
    const to = new URL(u.href);
    to.port = app.port;
    return to.href;
  };
}

/**
 * Installs the rewrite on `ctx` in local mode; on staging, nothing.
 *
 * Not route.continue({ url }): the browser checks CORS against the URL the
 * page asked for, which is cross-origin to the page (no port vs the pair's
 * port), and the Worker sends no CORS headers for its own origin, so the PUT
 * was blocked. So the request is sent to the pair's port as is (method,
 * headers, body) and its response handed back unchanged (status, headers,
 * body) plus one header: Access-Control-Allow-Origin, the pair's app origin,
 * which is the page's own. Playwright answers the CORS preflight itself for
 * a routed request. A failed upload still fails: its status is the Worker's.
 */
export async function installLocalRoute(
  ctx: Pick<BrowserContext, "route">,
  t: RouteTarget,
): Promise<void> {
  const rewrite = localPortRewrite(t);
  if (!rewrite) return;
  const origin = new URL(t.app).origin;
  await ctx.route(
    (u) => rewrite(u) !== null,
    async (route: Route) => {
      const to = rewrite(new URL(route.request().url()));
      if (!to) return route.continue();
      const response = await route.fetch({ url: to });
      return route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "access-control-allow-origin": origin,
        },
      });
    },
  );
}
