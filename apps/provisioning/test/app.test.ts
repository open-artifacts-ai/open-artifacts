import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { ADMIN, API, ctx, fakeEnv } from "./fakes.js";

type Body = { error: { code: string } };
async function call(
  url: string,
  init: RequestInit = {},
  e = fakeEnv(),
): Promise<{ res: Response; body: Body | string }> {
  // Cloudflare sets cf-connecting-ip on every edge request; tests do too.
  const headers = new Headers(init.headers);
  if (!headers.has("cf-connecting-ip"))
    headers.set("cf-connecting-ip", "192.0.2.9");
  const req = new Request(url, { ...init, headers }) as Parameters<
    typeof worker.fetch
  >[0];
  const res = await worker.fetch(req, e.env, ctx());
  const text = await res.text();
  let body: Body | string = text;
  try {
    body = JSON.parse(text) as Body;
  } catch {}
  return { res, body };
}
const code = (b: Body | string) => (typeof b === "string" ? b : b.error.code);

describe("host policy (2.2)", () => {
  it("an unknown host is 404", async () => {
    const { res, body } = await call("https://evil.test/v1/me");
    expect(res.status).toBe(404);
    expect(code(body)).toBe("not_found");
  });

  it("the admin host refuses Authorization (401)", async () => {
    const { res, body } = await call(`${ADMIN}/api/v1/me`, {
      headers: { authorization: "Bearer oat_x" },
    });
    expect(res.status).toBe(401);
    expect(code(body)).toBe("unauthenticated");
  });

  it("/mcp on the admin host and /oauth/authorize on the api host are 404", async () => {
    expect((await call(`${ADMIN}/mcp`, { method: "POST" })).res.status).toBe(
      404,
    );
    expect((await call(`${API}/oauth/authorize`)).res.status).toBe(404);
  });

  it("api-host OAuth endpoints are 404 on the admin host", async () => {
    for (const p of [
      "/oauth/token",
      "/oauth/register",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource/mcp",
    ])
      expect(
        (
          await call(`${ADMIN}${p}`, {
            method: p.startsWith("/oauth") ? "POST" : "GET",
          })
        ).res.status,
      ).toBe(404);
  });

  it("each base lives on its own host", async () => {
    expect((await call(`${API}/api/v1/me`)).res.status).toBe(404);
    expect((await call(`${ADMIN}/v1/me`)).res.status).toBe(404);
    expect((await call(`${API}/auth/start`)).res.status).toBe(404);
  });
});

describe("pre-authn IP limit (4.2)", () => {
  it("runs after host policy: a refused Authorization is not charged", async () => {
    const e = fakeEnv();
    await call(`${ADMIN}/api/v1/me`, { headers: { authorization: "x" } }, e);
    expect(e.limits.RL_PV_PRE_IP.keys).toEqual([]);
  });

  it("charges RL_PV_PRE_IP on every request", async () => {
    const e = fakeEnv();
    await call(
      `${API}/v1/me`,
      { headers: { "cf-connecting-ip": "192.0.2.1" } },
      e,
    );
    await call(
      `${ADMIN}/installs`,
      { headers: { "cf-connecting-ip": "192.0.2.2" } },
      e,
    );
    expect(e.limits.RL_PV_PRE_IP.keys).toEqual(["192.0.2.1", "192.0.2.2"]);
  });

  it("no or an unparseable cf-connecting-ip is 403, never a shared bucket", async () => {
    const e = fakeEnv();
    for (const headers of [
      {} as Record<string, string>,
      { "cf-connecting-ip": "" },
      { "cf-connecting-ip": "unknown" },
      { "cf-connecting-ip": "not-an-ip" },
    ]) {
      const req = new Request(`${API}/v1/me`, { headers }) as Parameters<
        typeof worker.fetch
      >[0];
      const res = await worker.fetch(req, e.env, ctx());
      expect(res.status).toBe(403);
      expect(((await res.json()) as Body).error.code).toBe("forbidden");
    }
    expect(e.limits.RL_PV_PRE_IP.keys).toEqual([]);
  });

  it("the pre-authn key is ipKey: IPv6 by /64", async () => {
    const e = fakeEnv();
    await call(
      `${API}/v1/me`,
      { headers: { "cf-connecting-ip": "2001:db8:1:2:3:4:5:6" } },
      e,
    );
    expect(e.limits.RL_PV_PRE_IP.keys).toEqual(["2001:db8:1:2::/64"]);
  });

  it("over the limit is 429; unbound is 503", async () => {
    const e = fakeEnv();
    e.limits.RL_PV_PRE_IP.allow = false;
    expect((await call(`${API}/v1/me`, {}, e)).res.status).toBe(429);
    const u = fakeEnv({ RL_PV_PRE_IP: undefined });
    const { res, body } = await call(`${API}/v1/me`, {}, u);
    expect(res.status).toBe(503);
    expect(code(body)).toBe("unavailable");
  });
});

describe("API routes", () => {
  it("no credential is 401 on both bases", async () => {
    for (const url of [`${API}/v1/installs`, `${ADMIN}/api/v1/installs`]) {
      const { res, body } = await call(url);
      expect(res.status).toBe(401);
      expect(code(body)).toBe("unauthenticated");
    }
  });

  it("an unknown API path is 404", async () => {
    expect((await call(`${API}/v1/nope`)).res.status).toBe(404);
  });

  it("sign-in routes are 501 stubs on the admin host", async () => {
    expect((await call(`${ADMIN}/auth/start`)).res.status).toBe(501);
    expect((await call(`${ADMIN}/auth/callback/google`)).res.status).toBe(501);
  });

  it("admin-host writes fail closed on Origin until W5a (403 csrf_failed)", async () => {
    for (const [method, path] of [
      ["POST", "/auth/logout"],
      ["POST", "/api/v1/installs"],
      ["DELETE", "/api/v1/tokens"],
    ] as const) {
      const e = fakeEnv();
      const { res, body } = await call(`${ADMIN}${path}`, { method }, e);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(code(body)).toBe("csrf_failed");
    }
    // api.<app> has no Origin or CSRF step: no cookie is read there.
    expect(
      (await call(`${API}/v1/installs`, { method: "POST" })).res.status,
    ).toBe(401);
  });

  it("other admin paths go to the SPA", async () => {
    const e = fakeEnv();
    const { res, body } = await call(`${ADMIN}/installs`, {}, e);
    expect(res.status).toBe(200);
    expect(body).toBe("spa");
    expect(e.assets).toHaveLength(1);
  });
});

describe("browser-host headers (4.5)", () => {
  const H = {
    "content-security-policy":
      "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  };

  it("are on the SPA and on every admin-host error", async () => {
    for (const [url, init] of [
      [`${ADMIN}/installs`, {}],
      [`${ADMIN}/api/v1/installs`, {}],
      [`${ADMIN}/api/v1/nope`, {}],
      [`${ADMIN}/mcp`, { method: "POST" }],
      [`${ADMIN}/auth/logout`, { method: "POST" }],
      [`${ADMIN}/api/v1/me`, { headers: { authorization: "x" } }],
      [`${ADMIN}/oauth/authorize`, {}],
    ] as const) {
      const { res } = await call(url, init);
      for (const [k, v] of Object.entries(H))
        expect(res.headers.get(k), `${url} ${k}`).toBe(v);
    }
  });

  it("override what the SPA sent", async () => {
    const { env } = fakeEnv({
      ASSETS: {
        fetch: async () =>
          new Response("spa", {
            headers: { "x-frame-options": "SAMEORIGIN" },
          }),
      } as unknown as Fetcher,
    });
    const { res } = await call(`${ADMIN}/installs`, {}, { ...fakeEnv(), env });
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("are not added on the api host", async () => {
    const { res } = await call(`${API}/v1/installs`);
    expect(res.headers.get("x-frame-options")).toBeNull();
  });
});

describe("a throw in a protocol handler or the SPA is the 3.5 envelope", () => {
  it("is 500 internal, not an uncaught Worker error", async () => {
    const { env } = fakeEnv({
      ASSETS: {
        fetch: async () => {
          throw new Error("boom");
        },
      } as unknown as Fetcher,
    });
    const { res, body } = await call(
      `${ADMIN}/installs`,
      {},
      {
        ...fakeEnv(),
        env,
      },
    );
    expect(res.status).toBe(500);
    expect(code(body)).toBe("internal");
  });
});

describe("MCP and OAuth stubs (9A.2, 9A.3.1)", () => {
  it("protocol paths follow PROTOCOL_ROUTES: wrong method 405, unknown path 404", async () => {
    const t = await call(`${API}/oauth/token`, { method: "GET" });
    expect(t.res.status).toBe(405);
    expect(t.res.headers.get("allow")).toBe("POST");
    // The 3.5 envelope shape, no-store.
    expect(t.body).toEqual({
      error: { code: "method_not_allowed", message: "Method not allowed." },
    });
    expect(t.res.headers.get("cache-control")).toBe("no-store");
    expect(t.res.headers.get("content-type")).toBe("application/json");
    const w = await call(`${API}/.well-known/oauth-authorization-server`, {
      method: "POST",
    });
    expect(w.res.status).toBe(405);
    expect(w.res.headers.get("allow")).toBe("GET");
    const a = await call(`${ADMIN}/oauth/authorize`, { method: "PUT" });
    expect(a.res.headers.get("allow")).toBe("GET, POST");
    for (const url of [`${API}/oauth/nope`, `${ADMIN}/oauth/nope`])
      expect((await call(url)).res.status, url).toBe(404);
  });

  it("POST /mcp is 501; GET and DELETE are 405 with allow: POST", async () => {
    expect((await call(`${API}/mcp`, { method: "POST" })).res.status).toBe(501);
    for (const method of ["GET", "DELETE"]) {
      const { res } = await call(`${API}/mcp`, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("/oauth/* and the well-known documents are 501", async () => {
    for (const [method, url] of [
      ["POST", `${API}/oauth/token`],
      ["POST", `${API}/oauth/register`],
      ["GET", `${API}/.well-known/oauth-authorization-server`],
      ["GET", `${API}/.well-known/oauth-protected-resource/mcp`],
      ["GET", `${ADMIN}/oauth/authorize`],
      ["POST", `${ADMIN}/oauth/authorize`],
    ] as const) {
      const { res, body } = await call(url, { method });
      expect(res.status, `${method} ${url}`).toBe(501);
      expect(code(body)).toBe("not_implemented");
    }
  });
});
