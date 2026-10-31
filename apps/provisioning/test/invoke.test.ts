import {
  API_ERROR_STATUS,
  type AuthzColumn,
  authorize,
  ROUTE_IDS,
  ROUTES,
  TokenScopeSchema,
} from "@oa/shared/provisioning";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import type { Principal } from "../src/principal.js";
import { invokeRoute, type Surface } from "../src/routes/invoke.js";
import { ctx, fakeEnv } from "./fakes.js";

const P = (kind: Principal["kind"], scopes: Principal["scopes"] = []) =>
  ({
    kind,
    actorKey: `${kind}:x`,
    rateKey: `${kind === "token" ? "admin" : kind}:x`,
    label: "x",
    scopes,
    ...(kind === "token" ? { tokenId: "t", authAt: null } : {}),
  }) satisfies Principal;
const ALL = TokenScopeSchema.options;
const SURFACES: Surface[] = [
  { kind: "http" },
  { kind: "mcp", tool: "list_installs", clientVersion: null },
];
const PRINCIPALS: Record<Exclude<AuthzColumn, "none">, Principal[]> = {
  admin: [P("admin")],
  token: [P("token"), P("token", ["installs:read"]), P("token", ALL)],
  oidc: [P("oidc")],
  user: [P("user")],
};

async function run(
  principal: Principal,
  route: (typeof ROUTE_IDS)[number],
  s: Surface,
) {
  const { env } = fakeEnv();
  try {
    const r = await invokeRoute(env, ctx(), principal, route, {}, s);
    return {
      status: r.status,
      code: (r.body as { error?: { code: string } }).error?.code,
    };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return { status: API_ERROR_STATUS[e.code], code: e.code };
  }
}

describe("invokeRoute (9A.4): authz.ts row, then the 501 stub", () => {
  for (const route of ROUTE_IDS)
    for (const [col, ps] of Object.entries(PRINCIPALS))
      for (const [i, p] of ps.entries())
        it(`${route} x ${col}#${i}: the authz row decides, same on both surfaces`, async () => {
          for (const env of ["staging", "prod"] as const) {
            const d = authorize(route, p, env);
            for (const s of SURFACES) {
              const { env: e } = fakeEnv({ OA_ENV: env });
              let got: { status: number; code?: string };
              try {
                const r = await invokeRoute(e, ctx(), p, route, {}, s);
                got = {
                  status: r.status,
                  code: (r.body as { error: { code: string } }).error.code,
                };
              } catch (err) {
                if (!(err instanceof ApiError)) throw err;
                got = { status: API_ERROR_STATUS[err.code], code: err.code };
              }
              if (d.ok)
                expect(got).toEqual({ status: 501, code: "not_implemented" });
              else
                expect(got).toEqual({
                  status: API_ERROR_STATUS[d.code],
                  code: d.code,
                });
            }
          }
        });

  it("R19 is admin only: a token with every scope is forbidden", async () => {
    expect(await run(P("token", ALL), "R19", SURFACES[0] as Surface)).toEqual({
      status: 403,
      code: "forbidden",
    });
  });

  it("charges RL_PV_WRITE on writes and RL_PV_READ on reads, by rateKey", async () => {
    const { env, limits } = fakeEnv();
    const p = P("admin");
    await invokeRoute(env, ctx(), p, "R2", {}, { kind: "http" });
    await invokeRoute(env, ctx(), p, "R7", {}, { kind: "http" });
    expect(ROUTES.R2.write).toBe(false);
    expect(ROUTES.R7.write).toBe(true);
    expect(limits.RL_PV_READ.keys).toEqual([p.rateKey]);
    expect(limits.RL_PV_WRITE.keys).toEqual([p.rateKey]);
  });

  it("the rate limit runs before authz", async () => {
    const { env, limits } = fakeEnv();
    limits.RL_PV_WRITE.allow = false;
    const err = await invokeRoute(
      env,
      ctx(),
      P("user"),
      "R19",
      {},
      { kind: "http" },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("rate_limited");
  });

  it("an unbound limit fails closed", async () => {
    const { env } = fakeEnv({ RL_PV_READ: undefined });
    const err = await invokeRoute(
      env,
      ctx(),
      P("admin"),
      "R1",
      {},
      { kind: "http" },
    ).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("unavailable");
  });
});
