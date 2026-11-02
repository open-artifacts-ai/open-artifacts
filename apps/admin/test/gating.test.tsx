import { fixtureMe } from "@oa/shared/provisioning/fixtures";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createClient } from "../src/api/client";
import { apiErr, http, json, renderApp, use } from "./harness";

afterEach(() => vi.unstubAllGlobals());

const me = (o: Record<string, unknown>) =>
  json({
    ...fixtureMe({
      principal: "admin",
      role: "admin",
      email: "a@example.com",
      csrf: "c",
      tokenId: null,
      tokenKind: null,
      tokenExpiresAt: null,
    }),
    ...o,
  });

for (const who of [
  { principal: "user", role: "user" },
  { principal: "admin", role: "user" },
  { principal: "token", role: "admin" },
]) {
  it(`sends ${who.principal}/${who.role} to no-access and shows no admin page or action`, async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      pathname: "/installs",
      search: "",
      assign,
    });
    use(http.get("*/api/v1/me", () => me(who)));
    renderApp("/installs");
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("/no-access?error=not_listed"),
    );
    expect(screen.queryByRole("heading", { name: "Installs" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Create install" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeNull();
  });
}

it("an admin session sees the pages", async () => {
  renderApp("/installs");
  expect(
    await screen.findByRole("heading", { name: "Installs" }),
  ).toBeInTheDocument();
});

it("a 403 on /me goes to no-access", async () => {
  const assign = vi.fn();
  vi.stubGlobal("location", {
    ...window.location,
    pathname: "/installs",
    search: "",
    assign,
  });
  use(http.get("*/api/v1/me", () => apiErr("forbidden", 403)));
  renderApp("/installs");
  await waitFor(() => expect(assign).toHaveBeenCalledWith("/no-access"));
});

it("a 403 on /me while already on no-access does not redirect again", async () => {
  const redirect = vi.fn();
  const client = createClient({
    fetch: (async () =>
      new Response(
        JSON.stringify({ error: { code: "forbidden", message: "x" } }),
        {
          status: 403,
        },
      )) as unknown as typeof fetch,
    redirect,
    currentPath: () => "/no-access?error=x",
  });
  await expect(client.me()).rejects.toMatchObject({ status: 403 });
  expect(redirect).not.toHaveBeenCalled();
});

it("a 403 on another call stays put", async () => {
  const redirect = vi.fn();
  const client = createClient({
    fetch: (async () =>
      new Response(
        JSON.stringify({ error: { code: "forbidden", message: "x" } }),
        {
          status: 403,
        },
      )) as unknown as typeof fetch,
    redirect,
    currentPath: () => "/installs",
  });
  await expect(client.get("/installs")).rejects.toMatchObject({ status: 403 });
  expect(redirect).not.toHaveBeenCalled();
});
