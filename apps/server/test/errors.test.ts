import { QUOTA_MESSAGE } from "@oa/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import {
  ApiError,
  appOrigin,
  isD1QuotaError,
  toErrorResponse,
} from "../src/http/errors.js";
import { securityHeaders } from "../src/http/middleware.js";

function appThrowing(e: unknown) {
  const app = new Hono();
  app.onError((err) => toErrorResponse(err));
  app.get("/x", () => {
    throw e;
  });
  return app;
}

describe("errors", () => {
  it("D1 quota error -> 503 quota_exceeded", async () => {
    const res = await appThrowing(
      new Error(
        "Your account has exceeded D1's free tier daily row read limit.",
      ),
    ).request("/x");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: { code: "quota_exceeded", message: QUOTA_MESSAGE },
    });
  });

  it.each([
    "D1_ERROR: internal error; reference = abc123",
    "KV GET failed: 500 Internal Server Error",
    "KV PUT failed: 503 Service Unavailable",
  ])("a storage failure is a retryable 503: %s", async (message) => {
    const res = await appThrowing(new Error(message)).request("/x");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("storage_unavailable");
    // The reference and the store's text stay in the log.
    expect(JSON.stringify(body)).not.toMatch(/abc123|D1_ERROR|KV/);
  });

  it("finds it as a cause, and still logs it as unhandled", async () => {
    const seen: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...a) => void seen.push(a.join(" ")));
    const e = new Error("list failed", {
      cause: new Error("D1_ERROR: internal error; reference = abc123"),
    });
    const res = await appThrowing(e).request("/x");
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(seen.join("\n")).toContain("unhandled_error");
  });

  it.each([
    "D1_ERROR: no such table: artifacts",
    "D1_ERROR: UNIQUE constraint failed: users.email",
    "KV GET failed: 400 Bad Request",
    "KV GET failed: 429 Too Many Requests",
    "my KV GET failed: 500 in a handler",
    "internal error",
  ])("anything else stays a plain 500: %s", async (message) => {
    const res = await appThrowing(new Error(message)).request("/x");
    expect(res.status).toBe(500);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(await res.json()).toEqual({
      error: { code: "internal", message: "Internal error" },
    });
  });

  it("ApiError not_found -> 404", async () => {
    const res = await appThrowing(new ApiError("not_found", "x")).request("/x");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "x" },
    });
  });

  it("ApiError details are included", async () => {
    const res = await appThrowing(
      new ApiError("bad_request", "m", { a: 1 }),
    ).request("/x");
    expect(
      ((await res.json()) as { error: { details: unknown } }).error.details,
    ).toEqual({ a: 1 });
  });

  it("generic Error -> 500 internal without stack", async () => {
    const err = new Error("boom");
    const res = await appThrowing(err).request("/x");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe("internal");
    expect(text).not.toContain("boom");
    expect(text).not.toContain("at ");
  });

  it("isD1QuotaError", () => {
    expect(isD1QuotaError(new Error("exceeded D1's free tier daily"))).toBe(
      true,
    );
    expect(isD1QuotaError(new Error("other"))).toBe(false);
    expect(isD1QuotaError("str")).toBe(false);
  });

  it("appOrigin", () => {
    expect(appOrigin({ APP_HOST: "a.b", ENVIRONMENT: "dev" } as Env)).toBe(
      "http://a.b",
    );
    expect(
      appOrigin({ APP_HOST: "a.b", ENVIRONMENT: "production" } as Env),
    ).toBe("https://a.b");
  });
});

describe("headers on thrown errors", () => {
  it("securityHeaders survive onError", async () => {
    const app = new Hono();
    app.use(securityHeaders());
    app.onError((err) => toErrorResponse(err));
    app.get("/x", () => {
      throw new Error("boom");
    });
    const res = await app.request("/x");
    expect(res.status).toBe(500);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});
