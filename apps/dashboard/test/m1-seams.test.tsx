// M1 whole-track review: cross-task seams (401 mid-session, signed-URL staleness, focus, cache).
import { AUTH, R } from "@oa/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { makeQueryClient } from "../src/api/queryClient";
import { RedirectProvider } from "../src/auth/redirect";
import { createAppRouter } from "../src/router";
import { useContentUrl } from "../src/viewer/useContentUrl";
import { arts, installHarness, server } from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
    setArtifact: vi.fn(),
  }),
}));

installHarness();

const id = (t: string) =>
  (arts.find((a) => a.title === t) as { id: string }).id;
const OWNED = id("Landing page");

const mount = (path: string) => {
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
  return { redirect, router };
};
const unauthorized = () =>
  HttpResponse.json(
    { error: { code: "unauthorized", message: "unauthorized" } },
    { status: 401 },
  );
const toLogin = (redirect: ReturnType<typeof vi.fn>) =>
  waitFor(
    () =>
      expect(redirect).toHaveBeenCalledWith(
        expect.stringContaining(AUTH.login),
      ),
    { timeout: 2000 },
  );

// /me is still cached as authed (staleTime 60 s) when the session expires.
describe("M1 401 mid-session sends the user to sign in", () => {
  it("library list 401", async () => {
    server.use(http.get("*/api/v1/artifacts", unauthorized));
    const { redirect } = mount("/");
    await toLogin(redirect);
  });

  it("search 401", async () => {
    server.use(http.get("*/api/v1/search", unauthorized));
    const { redirect } = mount("/search?q=notes");
    await toLogin(redirect);
  });

  it("diff 401 (versions)", async () => {
    server.use(http.get("*/api/v1/artifacts/:id/versions", unauthorized));
    const { redirect } = mount(`/a/${OWNED}/diff/1/2`);
    await toLogin(redirect);
  });

  it("viewer content-url 401 (artifact still cached)", async () => {
    server.use(http.get("*/api/v1/artifacts/:id/content-url", unauthorized));
    const { redirect } = mount(`/a/${OWNED}`);
    await screen.findByRole("button", { name: "More actions" });
    await toLogin(redirect);
  });
});

describe("M1 viewer content URL failure is never silent", () => {
  it("content-url 500 shows an error instead of a permanently blank body", async () => {
    server.use(
      http.get("*/api/v1/artifacts/:id/content-url", () =>
        HttpResponse.json(
          { error: { code: "internal", message: "boom" } },
          { status: 500 },
        ),
      ),
    );
    mount(`/a/${OWNED}`);
    await screen.findByRole("button", { name: "More actions" });
    await screen.findByRole("alert", {}, { timeout: 2000 });
  });
});

describe("M1 signed URL staleness", () => {
  it("refreshes when the tab wakes after the timer slept past expiry", async () => {
    let n = 0;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            url: `https://c.test/u${++n}`,
            version: 1,
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const wrap = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={makeQueryClient()}>
          {children}
        </QueryClientProvider>
      );
      const { result } = renderHook(() => useContentUrl("a1", 1), {
        wrapper: wrap,
      });
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(result.current.current).toBe("https://c.test/u1");
      // Laptop sleeps 11 min: wall clock moves, the 9-min timer has not fired.
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
        await vi.advanceTimersByTimeAsync(0);
      });
      // A reload must not hand out an expired URL.
      expect(result.current.current).toBe("https://c.test/u2");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("M1 keyboard: title edit returns focus", () => {
  for (const key of ["Enter", "Escape"])
    it(`${key} puts focus back on the title button`, async () => {
      mount(`/a/${OWNED}`);
      fireEvent.click(
        await screen.findByRole("button", { name: "Landing page" }),
      );
      const input = screen.getByRole("textbox", { name: "Title" });
      fireEvent.change(input, { target: { value: "Renamed" } });
      fireEvent.keyDown(input, { key });
      await waitFor(() =>
        expect(document.activeElement?.getAttribute("title")).toBe("Rename"),
      );
    });
});

describe("M1 delete does not refetch the deleted artifact", () => {
  it("no GET of the artifact after DELETE succeeds", async () => {
    const { router } = mount(`/a/${OWNED}`);
    await screen.findByRole("button", { name: "More actions" });
    const del = R.artifact(OWNED);
    // Drive the dialog directly: Radix menus need pointer events jsdom lacks.
    const trigger = screen.getByRole("button", { name: "More actions" });
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const methods: string[] = [];
    server.use(
      http.all(`*${del}`, ({ request }) => {
        methods.push(request.method);
        return undefined;
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    await act(() => new Promise((r) => setTimeout(r, 100)));
    // Any GET here is a refetch of a now-404 artifact.
    expect(methods).toEqual(["DELETE"]);
  });
});
