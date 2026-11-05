import { env } from "cloudflare:workers";
import { QUOTA_MESSAGE } from "@oa/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  ApiError,
  isD1QuotaError,
  toErrorResponse,
} from "../src/http/errors.js";
import { securityHeaders } from "../src/http/middleware.js";
import worker from "../src/index.js";
import { mountRoutes } from "../src/routes/index.js";

const CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads; frame-ancestors http://app.localhost";
let assetCalls: string[] = [];
const ASSETS = {
  fetch(req: Request) {
    assetCalls.push(new URL(req.url).pathname);
    return Promise.resolve(
      new Response("<html>SPA</html>", {
        headers: { "content-type": "text/html" },
      }),
    );
  },
};
const call = (url: string, init?: RequestInit) =>
  worker.fetch(
    new Request(url, init) as Request<unknown, IncomingRequestCfProperties>,
    { ...(env as object), ASSETS } as never,
    { waitUntil() {}, passThroughOnException() {} } as never,
  );
const APP = "http://app.localhost";
const CONTENT = "http://content.localhost";

describe("host dispatch", () => {
  for (const u of [
    "http://content.localhost:8787/robots.txt",
    "http://content.localhost./robots.txt",
    "http://CONTENT.localhost/robots.txt",
  ]) {
    it(`routes ${u} to content`, async () => {
      const res = await call(u);
      expect(res.headers.get("content-security-policy")).toBe(CSP);
    });
  }
  it("X-Forwarded-Host cannot switch hosts", async () => {
    const res = await call(`${APP}/healthz`, {
      headers: { "x-forwarded-host": "content.localhost" },
    });
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toBeNull();
    const res2 = await call(`${CONTENT}/robots.txt`, {
      headers: { "x-forwarded-host": "app.localhost" },
    });
    expect(res2.headers.get("content-security-policy")).toBe(CSP);
  });
});

describe("content host", () => {
  it("CSP on every response incl. errors", async () => {
    for (const p of ["/robots.txt", "/nope", "/index.html"]) {
      const res = await call(`${CONTENT}${p}`);
      expect(res.headers.get("content-security-policy")).toBe(CSP);
    }
  });
  it("robots HEAD ok, POST 405 + Allow + envelope", async () => {
    expect(
      (await call(`${CONTENT}/robots.txt`, { method: "HEAD" })).status,
    ).toBe(200);
    const res = await call(`${CONTENT}/robots.txt`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(await res.json()).toEqual({
      error: { code: "bad_request", message: "Method not allowed" },
    });
  });
  it("never touches ASSETS", async () => {
    assetCalls = [];
    for (const p of ["/", "/index.html", "/assets/x.js"]) {
      expect((await call(`${CONTENT}${p}`)).status).toBe(404);
    }
    expect(assetCalls).toEqual([]);
  });
});

describe("app host SPA fallback", () => {
  it("falls back to ASSETS for GET non-API", async () => {
    assetCalls = [];
    const res = await call(`${APP}/dashboard/x`);
    expect(await res.text()).toContain("SPA");
    expect(assetCalls).toEqual(["/dashboard/x"]);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
  it("API paths 404 as JSON, not SPA", async () => {
    assetCalls = [];
    for (const p of [
      "/api/v1/unknown",
      "/auth/x",
      "/oauth/x",
      "/.well-known/x",
      "/__oa/nightly",
    ]) {
      const res = await call(`${APP}${p}`);
      expect(res.status).toBe(404);
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe("not_found");
    }
    expect(assetCalls).toEqual([]);
  });
  it("POST to unknown path is JSON 404", async () => {
    const res = await call(`${APP}/dashboard/x`, { method: "POST" });
    expect(res.status).toBe(404);
  });
  it("405 body uses the envelope", async () => {
    const res = await call(`${APP}/healthz`, { method: "POST" });
    expect(await res.json()).toEqual({
      error: { code: "bad_request", message: "Method not allowed" },
    });
  });
});

describe("isD1QuotaError", () => {
  const msg = "exceeded D1's free tier daily";
  it("walks cause chain", () => {
    expect(isD1QuotaError(new Error("x", { cause: new Error(msg) }))).toBe(
      true,
    );
    expect(
      isD1QuotaError(
        new Error("a", { cause: new Error("b", { cause: new Error(msg) }) }),
      ),
    ).toBe(true);
  });
  it("plain objects", () => {
    expect(isD1QuotaError({ message: msg })).toBe(true);
    expect(isD1QuotaError({ message: 5 })).toBe(false);
  });
  it("depth capped and cycle safe", () => {
    let e: unknown = new Error(msg);
    for (let i = 0; i < 8; i++) e = new Error("w", { cause: e });
    expect(isD1QuotaError(e)).toBe(false);
    const a = new Error("a");
    (a as { cause?: unknown }).cause = a;
    expect(isD1QuotaError(a)).toBe(false);
  });
  it("quota via cause maps to 503", async () => {
    const res = toErrorResponse(new Error("x", { cause: { message: msg } }));
    expect(res.status).toBe(503);
    expect(
      ((await res.json()) as { error: { message: string } }).error.message,
    ).toBe(QUOTA_MESSAGE);
  });
});

describe("toErrorResponse mapping", () => {
  const cases: [number, string][] = [
    [400, "bad_request"],
    [401, "unauthorized"],
    [413, "too_large"],
    [418, "internal"],
    [500, "internal"],
  ];
  for (const [status, code] of cases) {
    it(`HTTPException ${status} -> ${code}`, async () => {
      const res = toErrorResponse(
        new HTTPException(status as 400, { message: "m" }),
      );
      expect(res.status).toBe(status);
      expect(
        ((await res.json()) as { error: { code: string } }).error.code,
      ).toBe(code);
    });
  }
  it("unknown ApiError code -> 500", () => {
    const res = toErrorResponse(new ApiError("weird" as never, "m"));
    expect(res.status).toBe(500);
  });
});

describe("securityHeaders immutability", () => {
  it("handles immutable headers (redirect)", async () => {
    const app = new Hono();
    app.use(securityHeaders());
    app.get("/r", () => Response.redirect("http://x.test/", 302));
    const res = await app.request("/r");
    expect(res.status).toBe(302);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("location")).toBe("http://x.test/");
  });
});

describe("route composition and SPA paths", () => {
  const callApp = (a: ReturnType<typeof createApp>, path: string) =>
    a.request(`${APP}${path}`, {}, { ...(env as object), ASSETS } as never);
  it("routes mounted via hook are not shadowed by the fallback", async () => {
    const a = createApp(
      (x) => {
        x.get("/api/v1/ping", (c) => c.json({ pong: 1 }));
        x.get("/dashboard/ping", (c) => c.text("mounted"));
      },
      {
        "GET /api/v1/ping": { public: "test" },
        "GET /dashboard/ping": { public: "test" },
      },
    );
    assetCalls = [];
    expect(await (await callApp(a, "/api/v1/ping")).json()).toEqual({
      pong: 1,
    });
    expect(await (await callApp(a, "/dashboard/ping")).text()).toBe("mounted");
    expect(assetCalls).toEqual([]);
  });
  it("mountRoutes default is a no-op export", () => {
    expect(typeof mountRoutes).toBe("function");
  });
  it("/a/*, /no-access, /search fall back to ASSETS", async () => {
    assetCalls = [];
    for (const p of ["/a/abc", "/a/abc/x", "/no-access", "/search"]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await call(`${APP}${p}`, { method });
        expect(res.status).toBe(200);
      }
    }
    expect(assetCalls.length).toBe(8);
  });
  it("/mcp and /mcp/* without a token → 401 challenge, never the SPA", async () => {
    assetCalls = [];
    for (const p of ["/mcp", "/mcp/x"]) {
      const r = await call(`${APP}${p}`);
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toMatch(/^Bearer /);
    }
    expect(assetCalls).toEqual([]);
  });
  it("skip check uses the decoded pathname", async () => {
    assetCalls = [];
    for (const p of [
      "/%61pi/v1/x",
      "/api%2Fv1/x",
      "/%2e%2e/api/x",
      "/%2Fapi/x",
    ]) {
      const res = await call(`${APP}${p}`);
      expect(res.status).toBe(404);
    }
    expect((await call(`${APP}/%E0%A4%A`)).status).toBe(404);
    expect(assetCalls).toEqual([]);
  });
});
