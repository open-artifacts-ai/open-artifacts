import { ROUTE_IDS, ROUTES, type RouteId } from "@oa/shared/provisioning";
import type { HostKind } from "../hosts.js";

// The route table (design v7 3.4) compiled from @oa/shared/provisioning.
// "api" routes sit under /v1 on api.<app> and /api/v1 on admin.<app>;
// "browser" routes (sign-in, logout) at the admin host's root only.

export const API_BASE: Record<HostKind, string> = {
  api: "/v1",
  admin: "/api/v1",
};

// A segment never holds a slash or a percent escape (no %2F tricks).
const SEG = "([^/%]+)";
const compiled = ROUTE_IDS.map((id) => {
  const r = ROUTES[id];
  const keys: string[] = [];
  const src = r.path.replace(
    /\/:(\w+)(\?)?/g,
    (_m, k: string, opt?: string) => {
      keys.push(k);
      return opt ? `(?:/${SEG})?` : `/${SEG}`;
    },
  );
  return {
    id,
    method: r.method,
    base: r.base,
    keys,
    re: new RegExp(`^${src}$`),
  };
});

export type RouteMatch = { route: RouteId; params: Record<string, string> };

export function matchRoute(
  host: HostKind,
  method: string,
  pathname: string,
): RouteMatch | null {
  const base = API_BASE[host];
  for (const c of compiled) {
    if (c.method !== method) continue;
    let path: string;
    if (c.base === "api") {
      if (!pathname.startsWith(`${base}/`)) continue;
      path = pathname.slice(base.length);
    } else {
      if (host !== "admin") continue;
      path = pathname;
    }
    const m = c.re.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    c.keys.forEach((k, i) => {
      const v = m[i + 1];
      if (v !== undefined) params[k] = v;
    });
    return { route: c.id, params };
  }
  return null;
}
