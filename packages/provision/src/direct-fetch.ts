// directFetch (design v7 5.2 f): the provisioner Worker reaches an install
// through its dispatch namespace binding, before (and without) any HOSTS
// route. Only the install's own app host goes through; any other URL throws,
// so a create can never health-check or selftest someone else's Worker.

/** The provisioner Worker's dispatch namespace binding (env.DISPATCHER). */
export interface DispatcherLike {
  get(name: string): { fetch(req: Request): Promise<Response> };
}

/** The install a directFetch reaches. */
export interface DirectRoute {
  appHost: string;
  script: string;
}

const ROUTE = Symbol.for("oa.provision.directFetch");
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const SCRIPT_RE = /^oa-[sp]-i[a-z0-9]{11}$/;

/**
 * A fetch for WfpOptions.fetch: `https://<appHost>/...` goes to
 * `dispatcher.get(script).fetch(...)`; any other scheme, host or port throws.
 */
export function directFetch(
  dispatcher: DispatcherLike,
  route: DirectRoute,
): typeof fetch {
  if (typeof dispatcher?.get !== "function")
    throw new Error("directFetch needs the dispatch namespace binding");
  if (typeof route?.appHost !== "string" || !HOST_RE.test(route.appHost))
    throw new Error("directFetch needs the install's app host");
  if (typeof route?.script !== "string" || !SCRIPT_RE.test(route.script))
    throw new Error("directFetch needs the install's script name");
  const { appHost, script } = route;
  const f = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    if (u.protocol !== "https:" || u.hostname !== appHost || u.port !== "")
      throw new Error(`directFetch reaches ${appHost} only`);
    return dispatcher.get(script).fetch(req);
  };
  Object.defineProperty(f, ROUTE, {
    value: Object.freeze({ appHost, script }),
  });
  return f as typeof fetch;
}

/** The install a directFetch reaches; undefined for any other fetch. */
export function directRouteOf(f: unknown): DirectRoute | undefined {
  if (typeof f !== "function") return undefined;
  return (f as unknown as Record<symbol, DirectRoute | undefined>)[ROUTE];
}
