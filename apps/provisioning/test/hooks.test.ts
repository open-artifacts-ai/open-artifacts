import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/errors.js";
import { invokeRoute, type Surface } from "../src/routes/invoke.js";
import { ADMIN_P, ctx, fakeEnv, resetDb, userP } from "./fakes.js";

// invokeRoute's one hook (hooks.ts): once per admitted call, after authz.

const h = vi.hoisted(() => ({
  calls: [] as { route: string; kind: string; surface: string }[],
  throws: false,
}));
vi.mock("../src/routes/hooks.js", () => ({
  onAuthenticated: (c: {
    route: string;
    principal: { kind: string };
    surface: { kind: string };
  }) => {
    h.calls.push({
      route: c.route,
      kind: c.principal.kind,
      surface: c.surface.kind,
    });
    if (h.throws) throw new Error("hook");
  },
}));

const HTTP: Surface = {
  kind: "http",
  client: { ip: "192.0.2.1", host: "api.hosted.test" },
};
const MCP: Surface = { kind: "mcp", tool: "get_world", clientVersion: null };

beforeEach(() => {
  h.calls = [];
  h.throws = false;
  return resetDb();
});

describe("onAuthenticated (9A.4)", () => {
  it("runs once per admitted call, on both surfaces, with the principal and route", async () => {
    const { env } = fakeEnv();
    await invokeRoute(env, ctx(), ADMIN_P, "R1", {}, HTTP);
    await invokeRoute(env, ctx(), ADMIN_P, "R1", {}, MCP);
    expect(h.calls).toEqual([
      { route: "R1", kind: "admin", surface: "http" },
      { route: "R1", kind: "admin", surface: "mcp" },
    ]);
  });

  it("an authz refusal never reaches it", async () => {
    const { env } = fakeEnv();
    await expect(
      invokeRoute(env, ctx(), userP(), "R27", {}, HTTP),
    ).rejects.toBeInstanceOf(ApiError);
    expect(h.calls).toEqual([]);
  });

  it("a throwing hook never fails the call", async () => {
    h.throws = true;
    const { env } = fakeEnv();
    const r = await invokeRoute(env, ctx(), ADMIN_P, "R1", {}, HTTP);
    expect(r.status).toBe(200);
    expect(h.calls).toHaveLength(1);
  });
});
