import {
  type AdminToolName,
  type ApiRouteId,
  authorize,
  INSTALL_ID_RE,
  REQUEST_ID_RE,
  ROUTES,
  type RouteDef,
  ULID_RE,
} from "@oa/shared/provisioning";
import { type AuditEntry, audit } from "../audit.js";
import { LazyBody } from "../body.js";
import type { Env } from "../env.js";
import { ApiError } from "../errors.js";
import { limit } from "../limits.js";
import type { Principal } from "../principal.js";
import { countRateLimited } from "../refuse.js";
import { HANDLERS } from "./handlers.js";
import { onAuthenticated } from "./hooks.js";

// The one entry point both surfaces call (design v7 9A.4). It runs the
// post-authn part of the 4.2 check order: rate limit -> authz (authz.ts) ->
// schema -> policy -> business -> handler -> audit, and throws ApiError on
// any refusal. W4 writes authz.refused and job.refused here; other streams
// plug in through onAuthenticated (hooks.ts), never by editing this body.
// The browser routes (R22-R24: cookies, Set-Cookie, redirects) never come
// here: W5a builds them beside it in src/auth/, and the adapter short-circuits
// them, so the type leaves them out: `route` is ApiRouteId (shared), the
// same type AdminToolDef.route carries, so the MCP adapter passes tool.route.

export type RouteInput = {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
};
/**
 * `client` is what W4's policy step needs and the adapter alone knows: `ip`
 * (cf-connecting-ip; R18's RL_PV_SLUG_IP, the self-serve /64 and /48
 * counters, Turnstile's remoteIp) and `host` (the request hostname,
 * Turnstile's hostname check). MCP carries none: self-serve users get 401
 * on /mcp (4.2).
 */
export type Surface =
  | { kind: "http"; client: { ip: string; host: string } }
  | { kind: "mcp"; tool: AdminToolName; clientVersion: string | null };
export type RouteResult = {
  status: number;
  body: unknown;
  headers: Record<string, string>;
};

type Parsed = { ok: true; input: RouteInput } | { ok: false; fields: string[] };

/** The schema step: the route's params, query and body zod, defaults applied. */
export function parseInput(def: RouteDef, input: RouteInput): Parsed {
  const fields: string[] = [];
  const one = (where: string, schema: RouteDef["body"], v: unknown) => {
    const r = schema.safeParse(v);
    if (r.success) return r.data as Record<string, unknown>;
    for (const i of r.error.issues)
      fields.push([where, ...i.path.map(String)].join("."));
    return undefined;
  };
  const params = one("params", def.params, input.params ?? {});
  const query = one("query", def.query, input.query ?? {});
  // A route without body fields takes none; a write with fields needs one.
  const body =
    def.method === "GET"
      ? undefined
      : one(
          "body",
          def.body,
          Object.keys(def.body.shape).length === 0 ? {} : input.body,
        );
  if (fields.length) return { ok: false, fields };
  return {
    ok: true,
    input: {
      params: params as Record<string, string>,
      query: query as Record<string, string>,
      body,
    },
  };
}

/** Audit never masks the refusal it records. */
const tryAudit = (env: Env, e: AuditEntry) => audit(env, e).catch(() => {});

export async function invokeRoute(
  env: Env,
  ctx: ExecutionContext,
  principal: Principal,
  route: ApiRouteId,
  input: RouteInput,
  surface: Surface,
): Promise<RouteResult> {
  const def = ROUTES[route];
  const r = await limit(env, def.write ? "write" : "read", principal.rateKey);
  if (r) {
    if (r.code === "rate_limited")
      await countRateLimited(env, principal.rateKey);
    throw new ApiError(r.code);
  }
  const d = authorize(route, principal, env.OA_ENV);
  if (!d.ok) {
    await tryAudit(env, {
      action: "authz.refused",
      actor: principal,
      outcome: "refused",
      route,
      code: d.code,
      surface,
    });
    throw new ApiError(d.code);
  }
  // The one hook (hooks.ts): W5b's token.used. It never fails the call.
  try {
    onAuthenticated({ env, ctx, principal, route, surface });
  } catch {}
  let input2: RouteInput = input;
  try {
    // The HTTP body step (415, 413, JSON) runs here, as part of schema.
    const body =
      input.body instanceof LazyBody ? await input.body.read() : input.body;
    input2 = { ...input, body };
    const parsed = parseInput(def, input2);
    if (!parsed.ok)
      throw new ApiError("invalid_input", "invalid input", {
        fields: parsed.fields,
      });
    input2 = parsed.input;
    return await HANDLERS[route]({
      env,
      ctx,
      principal,
      route,
      input: parsed.input,
      surface,
      reach: d.reach,
    });
  } catch (e) {
    // A handler's own limit (R18, R4 self-serve) is a 429 like any other.
    if (e instanceof ApiError && e.code === "rate_limited")
      await countRateLimited(env, principal.rateKey);
    // A refused job write (schema, policy or business) is job.refused (4.9).
    // A schema refusal records only the raw input's well-formed ids.
    if (e instanceof ApiError && def.job) {
      const body = input2.body as { requestId?: unknown } | undefined;
      const params = input2.params ?? {};
      const id = (v: unknown, re: RegExp) =>
        typeof v === "string" && re.test(v) ? v : undefined;
      const jobId = id(params.jobId, ULID_RE);
      await tryAudit(env, {
        action: "job.refused",
        actor: principal,
        outcome: "refused",
        route,
        code: e.code,
        installId: id(params.id, INSTALL_ID_RE),
        requestId: id(body?.requestId, REQUEST_ID_RE),
        surface,
        detail: jobId ? { jobId } : undefined,
      });
    }
    throw e;
  }
}
