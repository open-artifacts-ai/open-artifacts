import { QUOTA_MESSAGE, type Role } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeQueryClient } from "../src/api/queryClient";
import { RedirectProvider } from "../src/auth/redirect";
import { createAppRouter } from "../src/router";

type Who = Role | "anonymous" | "quota";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const mount = async (who: Who, path = "/") => {
  vi.stubGlobal("fetch", async () => {
    if (who === "anonymous")
      return json({ error: { code: "unauthorized", message: "no" } }, 401);
    if (who === "quota")
      return json({ error: { code: "quota_exceeded", message: "q" } }, 503);
    const me = structuredClone(fixtures.me);
    me.user.role = who;
    return json(me);
  });
  const redirect = vi.fn();
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [path] }),
  );
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <RedirectProvider value={redirect}>
        <RouterProvider router={router} />
      </RedirectProvider>
    </QueryClientProvider>,
  );
  lastRouter = router;
  return redirect;
};
let lastRouter: ReturnType<typeof createAppRouter> | undefined;

afterEach(() => vi.unstubAllGlobals());

const nav = () => screen.queryByRole("navigation", { name: "Primary" });
const link = (name: string) => screen.queryByRole("link", { name });

describe("AppLayout", () => {
  it("guest sees only Shared with you", async () => {
    await mount("guest");
    // #2590: a guest's home is "Shared with you".
    await screen.findAllByRole("link", { name: "Shared with you" });
    expect(link("Team")).toBeNull();
    expect(link("Settings")).toBeNull();
    expect(link("Usage")).toBeNull();
    expect(nav()).not.toBeNull();
  });

  it("member sees Team and Settings but not Usage", async () => {
    await mount("member");
    await screen.findAllByRole("link", { name: "Settings" });
    expect(link("Team")).not.toBeNull();
    expect(link("Usage")).toBeNull();
  });

  it("owner sees Usage", async () => {
    await mount("owner");
    expect(
      (await screen.findAllByRole("link", { name: "Usage" })).length,
    ).toBeGreaterThan(0);
  });

  it("anonymous at / redirects to login with next=/", async () => {
    const redirect = await mount("anonymous", "/");
    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith("/auth/login?next=%2F"),
    );
  });

  it("anonymous at an unknown path keeps it as next", async () => {
    const redirect = await mount("anonymous", "/invite/x");
    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith("/auth/login?next=%2Finvite%2Fx"),
    );
  });

  it("anonymous at /a/x is not bounced by the layout", async () => {
    const redirect = await mount("anonymous", "/a/x");
    // The layout lets /a/* through; the viewer itself sends the anonymous visitor to login.
    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith("/auth/login?next=%2Fa%2Fx"),
    );
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it("starts each page at the top of the scrolling content", async () => {
    await mount("member");
    await screen.findAllByRole("link", { name: "Team" });
    const main = document.getElementById("oa-main") as HTMLElement;
    main.scrollTop = 150;
    expect(main.scrollTop).toBe(150);
    await lastRouter?.navigate({ to: "/team" as string });
    await waitFor(() => expect(main.scrollTop).toBe(0));
  });

  it("shows the quota banner with QUOTA_MESSAGE", async () => {
    await mount("quota");
    expect(await screen.findByText(QUOTA_MESSAGE)).toBeInTheDocument();
  });
});
