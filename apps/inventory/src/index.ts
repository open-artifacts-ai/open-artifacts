import { verify as ghVerify } from "@oa/gh-oidc";
import { authenticate, type OidcVars, type Verify } from "./auth.ts";
import { health } from "./health.ts";
import { listHosts, oneHost } from "./hosts.ts";
import {
  type D1Like,
  internal,
  type KvReadLike,
  methodNotAllowed,
  notFound,
} from "./http.ts";
import { listInstalls } from "./installs.ts";
import { postProdclean } from "./prodclean.ts";

// The inventory Worker (design v7 6.3): GET /installs, /hosts, /health and the
// monitor's POST /prodclean, every route behind a GitHub Actions OIDC bearer.

export type { D1Like, KvReadLike } from "./http.ts";

export interface Env extends OidcVars {
  PLATFORM_DB: D1Like;
  /** host -> HOSTS value (oa-<p>-hosts), the namespace dispatch reads. */
  HOSTS: KvReadLike;
}

const ROUTES: Record<string, string> = {
  "/installs": "GET",
  "/hosts": "GET",
  "/health": "GET",
  "/prodclean": "POST",
};

export function makeWorker(deps: { verify: Verify; now: () => number }) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      // Auth first: an unauthenticated caller learns nothing, not even routes.
      const auth = await authenticate(request, env, deps.verify);
      if (auth instanceof Response) return auth;
      const url = new URL(request.url);
      const method = Object.hasOwn(ROUTES, url.pathname)
        ? ROUTES[url.pathname]
        : undefined;
      if (!method) return notFound();
      if (request.method !== method) return methodNotAllowed(method);
      try {
        switch (url.pathname) {
          case "/hosts": {
            const host = url.searchParams.get("host");
            return host === null
              ? await listHosts(env.HOSTS)
              : await oneHost(env.HOSTS, host);
          }
          case "/installs":
            return await listInstalls(env.PLATFORM_DB, env.HOSTS);
          case "/health":
            return await health(env.PLATFORM_DB);
          default:
            return await postProdclean(
              request,
              auth,
              env.PLATFORM_DB,
              deps.now,
            );
        }
      } catch {
        // A schema or binding failure: fixed body, nothing echoed.
        return internal();
      }
    },
  };
}

export default makeWorker({ verify: ghVerify, now: Date.now });
