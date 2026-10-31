import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { ADMIN, API, ctx, fakeEnv } from "./fakes.js";

type Body = { error: { code: string } };
async function call(
  url: string,
  init: RequestInit = {},
  e = fakeEnv(),
): Promise<{ res: Response; body: Body | string }> {
  const req = new Request(url, init) as Parameters<typeof worker.fetch>[0];
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
    expect(
      (await call(`${ADMIN}/auth/logout`, { method: "POST" })).res.status,
    ).toBe(501);
  });

  it("other admin paths go to the SPA", async () => {
    const e = fakeEnv();
    const { res, body } = await call(`${ADMIN}/installs`, {}, e);
    expect(res.status).toBe(200);
    expect(body).toBe("spa");
    expect(e.assets).toHaveLength(1);
  });
});

describe("MCP and OAuth stubs (9A.2, 9A.3.1)", () => {
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
