// #1252: the local pair's port rewrite (e2e/staging/local-route.ts). Staging
// installs nothing; local rewrites only port-less URLs on the pair's own
// hosts, to the pair's port, same protocol.
import { describe, expect, it } from "vitest";
import {
  installLocalRoute,
  localPortRewrite,
} from "../e2e/staging/local-route";

const LOCAL = { app: "http://rl-a.app.localhost:41234", local: true };
const STAGING = {
  app: "https://rl-a.open-artifacts-staging.app",
  local: false,
};

const fakeCtx = () => {
  const calls: unknown[] = [];
  return {
    calls,
    route: (async (...a: unknown[]) => {
      calls.push(a);
    }) as never,
  };
};

describe("T19 local port rewrite", () => {
  it("staging mode installs nothing", async () => {
    expect(localPortRewrite(STAGING)).toBeUndefined();
    const ctx = fakeCtx();
    await installLocalRoute(ctx, STAGING);
    expect(ctx.calls).toHaveLength(0);
  });

  it("local mode installs one route", async () => {
    const ctx = fakeCtx();
    await installLocalRoute(ctx, LOCAL);
    expect(ctx.calls).toHaveLength(1);
  });

  it("moves port-less URLs on the pair's app and content hosts to its port", () => {
    const r = localPortRewrite(LOCAL);
    if (!r) throw new Error("no rewrite");
    expect(
      r(new URL("http://rl-a.app.localhost/api/v1/uploads/u1?exp=1&sig=s")),
    ).toBe("http://rl-a.app.localhost:41234/api/v1/uploads/u1?exp=1&sig=s");
    expect(r(new URL("http://rl-a.content.localhost/a/x/index.html"))).toBe(
      "http://rl-a.content.localhost:41234/a/x/index.html",
    );
  });

  it("leaves every other request untouched", () => {
    const r = localPortRewrite(LOCAL);
    if (!r) throw new Error("no rewrite");
    for (const u of [
      // Already on a port (the pair's own, or any other).
      "http://rl-a.app.localhost:41234/api/v1/me",
      "http://rl-a.app.localhost:8080/x",
      // Other hosts: the other install, other localhost names, the outside.
      "http://rl-b.app.localhost/x",
      "http://evil.localhost/x",
      "http://localhost/x",
      "http://127.0.0.1/x",
      "http://rl-a.app.localhost.example.com/x",
      "https://rl-a.open-artifacts-staging.app/x",
      // Another protocol on the pair's host.
      "https://rl-a.app.localhost/x",
      "ws://rl-a.app.localhost/x",
    ])
      expect([u, r(new URL(u))]).toEqual([u, null]);
  });
});
