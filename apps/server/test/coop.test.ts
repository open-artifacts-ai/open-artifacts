// COOP same-origin on every app-host response (a popup opened from an
// artifact can't reach back into our pages); never on the content host.
import { env } from "cloudflare:workers";
import { ARTIFACT_SANDBOX } from "@oa/shared";
import { describe, expect, it } from "vitest";
import { COOP_EXEMPT } from "../src/http/middleware.js";
import worker from "../src/index.js";
import { contentCall, ctx, fakeAssets } from "./assets-stub.js";

const appCall = (path: string, init?: RequestInit) =>
  worker.fetch(
    new Request(`http://app.localhost${path}`, init) as never,
    { ...(env as object), ASSETS: fakeAssets().fetcher } as never,
    ctx,
  );

describe("Cross-Origin-Opener-Policy", () => {
  it("is same-origin on app-host responses", async () => {
    for (const p of [
      "/",
      "/a/abc123",
      "/a/abc123/full",
      "/search",
      "/settings/agents",
      "/api/v1/me",
      "/api/v1/nope",
      "/.well-known/oauth-authorization-server",
      "/mcp",
    ]) {
      const r = await appCall(p);
      expect(r.headers.get("cross-origin-opener-policy"), p).toBe(
        "same-origin",
      );
      expect(r.headers.get("x-frame-options"), p).toBe("DENY");
    }
  });

  // Web MCP clients run OAuth in a popup and get the result back through
  // window.opener; COOP on these pages would sever it. Exact paths only.
  it("is absent on the login popup pages, and only those", async () => {
    expect([...COOP_EXEMPT].sort()).toEqual([
      "/auth/callback",
      "/auth/callback/google",
      "/auth/dev-login",
      "/auth/login",
      "/auth/login/google",
      "/oauth/authorize",
      "/sign-in",
    ]);
    for (const [p, method] of [
      ["/oauth/authorize?client_id=x&response_type=code", "GET"],
      ["/oauth/authorize", "POST"],
      ["/auth/login?next=%2F", "GET"],
      ["/auth/callback?code=x&state=y", "GET"],
      ["/auth/dev-login", "GET"],
    ] as const) {
      const r = await appCall(p, { method });
      expect(
        r.headers.get("cross-origin-opener-policy"),
        `${method} ${p}`,
      ).toBeNull();
      expect(r.headers.get("x-frame-options"), p).toBe("DENY");
    }
    // Near misses keep COOP.
    for (const p of ["/oauth/authorize/", "/auth/logout", "/oauth/token"]) {
      const r = await appCall(p);
      expect(r.headers.get("cross-origin-opener-policy"), p).toBe(
        "same-origin",
      );
    }
  });

  it("is absent on content-host responses", async () => {
    for (const p of ["/", "/robots.txt", "/c/garbage/x/v1/__view"]) {
      const r = await contentCall(p);
      expect(r.headers.get("cross-origin-opener-policy"), p).toBeNull();
      expect(r.headers.get("content-security-policy"), p).toContain(
        `sandbox ${ARTIFACT_SANDBOX.join(" ")}`,
      );
    }
  });
});
