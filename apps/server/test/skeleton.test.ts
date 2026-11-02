import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { VERSION } from "../src/version.gen.js";

const call = (url: string, init?: RequestInit) =>
  worker.fetch(
    new Request(url, init) as Request<unknown, IncomingRequestCfProperties>,
    env as never,
    { waitUntil() {}, passThroughOnException() {} } as never,
  );
const APP = "http://app.localhost";
const CONTENT = "http://content.localhost";

describe("skeleton", () => {
  it("GET /healthz on app host", async () => {
    const res = await call(`${APP}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      plan: "free",
      version: VERSION,
      oauthStore: { mode: "kv", backfilled: false, kvWritesOffSince: null },
    });
  });

  for (const base of [APP, CONTENT]) {
    it(`robots.txt on ${base}`, async () => {
      const res = await call(`${base}/robots.txt`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("User-agent: *\nDisallow: /");
    });
  }

  for (const url of [
    `${APP}/healthz`,
    `${APP}/robots.txt`,
    `${APP}/api/v1/nope`,
    `${CONTENT}/robots.txt`,
    `${CONTENT}/nope`,
  ]) {
    it(`security headers on ${url}`, async () => {
      const res = await call(url);
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      // Content host: no-referrer, so signed tokens never leak via Referer.
      expect(res.headers.get("referrer-policy")).toBe(
        url.startsWith(CONTENT)
          ? "no-referrer"
          : "strict-origin-when-cross-origin",
      );
    });
  }

  it("X-Frame-Options DENY on app-host responses", async () => {
    const res = await call(`${APP}/`, { headers: { accept: "text/html" } });
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("unknown app route is JSON not_found", async () => {
    const res = await call(`${APP}/api/v1/nope`);
    expect(res.status).toBe(404);
    expect((await res.json()) as unknown).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("content host stub 404s and sets no cookie", async () => {
    const res = await call(`${CONTENT}/anything`);
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("HEAD ok, other methods 405 with Allow", async () => {
    for (const p of ["/healthz", "/robots.txt"]) {
      const h = await call(`${APP}${p}`, { method: "HEAD" });
      expect(h.status).toBe(200);
      const post = await call(`${APP}${p}`, { method: "POST" });
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET, HEAD");
    }
  });

  it("no cookies; trailing slash stays 404 (no ASSETS bound)", async () => {
    const r = await call(`${APP}/healthz`);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect((await call(`${APP}/healthz/`)).status).toBe(404);
  });

  it("404 envelope message", async () => {
    const r = await call(`${APP}/api/v1/nope`);
    expect(await r.json()).toEqual({
      error: { code: "not_found", message: "Not found" },
    });
  });
});
