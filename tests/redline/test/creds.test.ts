import { describe, expect, it } from "vitest";
import {
  authorizeRefused,
  once,
  slot,
  slotValue,
  tokenRefused,
} from "../src/creds.ts";
import { NotRefused, registerMarker } from "../src/refused.ts";
import type { Target } from "../src/targets.ts";

const B = {
  name: "rl-b",
  app: "https://rl-b.example.app",
  content: "https://rl-b.example.page",
} as Target;

const json = (status: number, body: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("tokenRefused", () => {
  const r = tokenRefused(["invalid_grant"]);
  it("accepts a 400 invalid_grant with no token", async () => {
    await expect(
      r(json(400, { error: "invalid_grant" }), B),
    ).resolves.toBeUndefined();
  });
  it("rejects a 200", async () => {
    await expect(r(json(200, { access_token: "x" }), B)).rejects.toThrow(
      NotRefused,
    );
  });
  it("rejects an error response that carries a token", async () => {
    await expect(
      r(json(400, { error: "invalid_grant", access_token: "x" }), B),
    ).rejects.toThrow(/a token was issued/);
  });
  it("rejects an error outside the allowed set", async () => {
    await expect(r(json(401, { error: "invalid_client" }), B)).rejects.toThrow(
      /error is not/,
    );
  });
  it("rejects a 403 (only 400 or 401)", async () => {
    await expect(r(json(403, { error: "invalid_grant" }), B)).rejects.toThrow(
      NotRefused,
    );
  });
  it("rejects a non-JSON body", async () => {
    await expect(r(new Response("nope", { status: 400 }), B)).rejects.toThrow(
      /not an OAuth error/,
    );
  });
});

describe("authorizeRefused", () => {
  it("accepts a 400 page", async () => {
    await expect(
      authorizeRefused(new Response("bad client", { status: 400 }), B),
    ).resolves.toBeUndefined();
  });
  it("rejects a redirect carrying a code", async () => {
    const res = new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/cb?code=abc&state=s" },
    });
    await expect(authorizeRefused(res, B)).rejects.toThrow(/with a code/);
  });
  it("rejects a 200", async () => {
    await expect(
      authorizeRefused(new Response("<p>hi</p>", { status: 200 }), B),
    ).rejects.toThrow(NotRefused);
  });
  const consentPage =
    '<form><input type="hidden" name="csrf" value="1.x">' +
    '<input type="hidden" name="request" value="h"></form>';
  it("rejects a consent page (B resolved A's client)", async () => {
    await expect(
      authorizeRefused(new Response(consentPage, { status: 200 }), B),
    ).rejects.toThrow(NotRefused);
  });
  it("rejects a 400 that still carries a consent form", async () => {
    await expect(
      authorizeRefused(new Response(consentPage, { status: 400 }), B),
    ).rejects.toThrow(/consent form/);
  });
  it("rejects a body holding a seeded marker", async () => {
    registerMarker(B, "REDLINE-rl-b-authz");
    await expect(
      authorizeRefused(
        new Response("x REDLINE-rl-b-authz", { status: 400 }),
        B,
      ),
    ).rejects.toThrow(/marker/);
  });
});

describe("slots", () => {
  it("resolve per host, and once() hands out each value once", () => {
    const A = { ...B, name: "rl-a" } as Target;
    const c = slot((t) => t.name);
    expect(slotValue(c, A)).toBe("rl-a");
    expect(slotValue(c, B)).toBe("rl-b");
    const next = once(1, 2);
    expect([next(), next()]).toEqual([1, 2]);
    expect(next).toThrow(/already used/);
  });
});
