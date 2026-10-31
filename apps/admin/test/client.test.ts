import { describe, expect, it, vi } from "vitest";
import { ApiError, createClient } from "../src/api/client";

const ME = {
  email: "a@example.com",
  role: "platform_admin",
  env: "prod",
  csrf: "tok",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const setup = (responses: Response[], here = "/installs/x?y=1") => {
  const queue = [...responses];
  const fetch = vi.fn(async () => queue.shift() ?? json({}));
  const redirect = vi.fn();
  const client = createClient({
    fetch: fetch as unknown as typeof globalThis.fetch,
    redirect,
    currentPath: () => here,
  });
  const lastInit = () =>
    (fetch.mock.calls.at(-1) as unknown as [string, RequestInit])[1];
  return { client, fetch, redirect, lastInit };
};

describe("client", () => {
  it("calls /api/v1 with same-origin credentials", async () => {
    const { client, fetch, lastInit } = setup([json(ME)]);
    await client.me();
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("/api/v1/me");
    expect(lastInit().credentials).toBe("same-origin");
  });

  it("sends the CSRF token on writes only", async () => {
    const { client, lastInit } = setup([
      json(ME),
      json({}),
      json({}),
      json({}),
      json({}),
    ]);
    await client.me();
    await client.get("/installs");
    expect(
      (lastInit().headers as Record<string, string>)["x-csrf-token"],
    ).toBeUndefined();
    for (const m of ["post", "put", "patch"] as const) {
      await client[m]("/installs", {});
      expect(
        (lastInit().headers as Record<string, string>)["x-csrf-token"],
      ).toBe("tok");
    }
    await client.delete("/installs/x");
    expect((lastInit().headers as Record<string, string>)["x-csrf-token"]).toBe(
      "tok",
    );
  });

  it("sends no CSRF token before /api/v1/me", async () => {
    const { client, lastInit } = setup([json({})]);
    await client.post("/x", {});
    expect(
      (lastInit().headers as Record<string, string>)["x-csrf-token"],
    ).toBeUndefined();
  });

  it("401 goes to sign-in with a safe return", async () => {
    const { client, redirect } = setup([
      json({ error: "unauthenticated" }, 401),
    ]);
    await expect(client.get("/x")).rejects.toMatchObject({
      status: 401,
      code: "unauthenticated",
    });
    expect(redirect).toHaveBeenCalledWith(
      `/sign-in?return=${encodeURIComponent("/installs/x?y=1")}`,
    );
  });

  it("401 from a hostile location falls back to /", async () => {
    const { client, redirect } = setup(
      [json({ error: "unauthenticated" }, 401)],
      "//evil.example",
    );
    await expect(client.get("/x")).rejects.toBeInstanceOf(ApiError);
    expect(redirect).toHaveBeenCalledWith("/sign-in?return=%2Finstalls");
  });

  it("401 on the sign-in screen does not loop", async () => {
    const { client, redirect } = setup(
      [json({ error: "unauthenticated" }, 401)],
      "/sign-in?error=denied",
    );
    await expect(client.get("/x")).rejects.toBeInstanceOf(ApiError);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("403 no_access goes to /no-access", async () => {
    const { client, redirect } = setup([json({ error: "no_access" }, 403)]);
    await expect(client.get("/x")).rejects.toMatchObject({
      status: 403,
      code: "no_access",
    });
    expect(redirect).toHaveBeenCalledWith("/no-access");
  });

  it("401 on /no-access does not redirect", async () => {
    const { client, redirect } = setup(
      [json({ error: "unauthenticated" }, 401)],
      "/no-access?error=not_listed",
    );
    await expect(client.me()).rejects.toMatchObject({ status: 401 });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("logout POSTs /auth/logout (outside /api) with the CSRF token", async () => {
    const { client, fetch, lastInit } = setup([
      json(ME),
      new Response(null, { status: 204 }),
    ]);
    await client.me();
    await client.logout();
    expect((fetch.mock.calls.at(-1) as unknown as [string])[0]).toBe(
      "/auth/logout",
    );
    expect(lastInit().method).toBe("POST");
    expect((lastInit().headers as Record<string, string>)["x-csrf-token"]).toBe(
      "tok",
    );
  });

  it("403 no_access while on /no-access does not redirect", async () => {
    const { client, redirect } = setup(
      [json({ error: "no_access" }, 403)],
      "/no-access",
    );
    await expect(client.me()).rejects.toMatchObject({
      status: 403,
      code: "no_access",
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("other 403s stay put and keep their code", async () => {
    const { client, redirect } = setup([json({ error: "csrf" }, 403)]);
    await expect(client.post("/x")).rejects.toMatchObject({
      status: 403,
      code: "csrf",
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("parses { error } and tolerates a non-JSON error body", async () => {
    const { client } = setup([
      json({ error: "slug_taken" }, 409),
      new Response("boom", { status: 500 }),
    ]);
    await expect(client.get("/x")).rejects.toMatchObject({
      status: 409,
      code: "slug_taken",
    });
    await expect(client.get("/x")).rejects.toMatchObject({
      status: 500,
      code: "unknown",
    });
  });
});
