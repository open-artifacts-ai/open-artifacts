import { AUTH, R, viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeQueryClient } from "../src/api/queryClient";
import { RedirectProvider } from "../src/auth/redirect";
import { createAppRouter } from "../src/router";
import { installHarness, seen, server, wait } from "./harness";

// Like the real bridge, the mock loads the frame (Shell ignores earlier loads).
vi.mock("../src/viewer/bridge", async () => {
  const { loadArtifactFrame } = await import("../src/viewer/frame");
  return {
    createBridge: (o: { iframe: HTMLIFrameElement; url: string }) => {
      loadArtifactFrame(o.iframe, o.url);
      return {
        dispose: () => {},
        requestThumbnail: () => {},
        setTheme: () => {},
        setArtifact: () => {},
      };
    },
  };
});

installHarness();
afterEach(() => vi.useRealTimers());

const id = (title: string) =>
  (fixtures.artifacts.find((a) => a.title === title) as { id: string }).id;
const OWNED = id("Landing page");
const PUBLIC = id("Q4 report");
const SCRIPT = id("Parser script"); // 25 versions, page size 20

const mount = (path: string) => {
  const redirect = vi.fn();
  const client = makeQueryClient();
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [path] }),
  );
  render(
    <QueryClientProvider client={client}>
      <RedirectProvider value={redirect}>
        <RouterProvider router={router} />
      </RedirectProvider>
    </QueryClientProvider>,
  );
  return { redirect, client, router };
};
const err = (status: number, code: string) =>
  HttpResponse.json({ error: { code, message: code } }, { status });
const anonymous = () =>
  server.use(http.get("*/api/v1/me", () => err(401, "unauthorized")));
const artifactIs = (status: number, code: string) =>
  server.use(http.get("*/api/v1/artifacts/:id", () => err(status, code)));
const frame = () =>
  waitFor(() => {
    const f = document.querySelector("iframe");
    if (!f) throw new Error("no iframe");
    return f;
  });
const login = (path: string) =>
  `${AUTH.login}?next=${encodeURIComponent(path)}`;

describe("viewer shell review", () => {
  it("anonymous + 404 redirects to login with next incl. version", async () => {
    anonymous();
    artifactIs(404, "not_found");
    const { redirect } = mount(viewerPath(OWNED, 2));
    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith(login(viewerPath(OWNED, 2))),
    );
  });

  it("authed + 401 on the artifact redirects to login", async () => {
    artifactIs(401, "unauthorized");
    const { redirect } = mount(viewerPath(OWNED));
    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith(login(viewerPath(OWNED))),
    );
  });

  it("Sign in link keeps the version in next", async () => {
    anonymous();
    mount(viewerPath(PUBLIC, 1));
    await frame();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      login(viewerPath(PUBLIC, 1)),
    );
  });

  it("deep link to a nonexistent version shows NotFound", async () => {
    server.use(
      http.get("*/api/v1/artifacts/:id/content-url", ({ request }) =>
        new URL(request.url).searchParams.get("v") === "99"
          ? err(404, "not_found")
          : undefined,
      ),
    );
    mount(viewerPath(OWNED, 99));
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
  });

  it("v=0 is NotFound without requesting a content URL", async () => {
    mount(`/a/${OWNED}/v/0`);
    await screen.findByText("Page not found");
    await wait(50);
    expect(seen.some((u) => u.pathname.endsWith("/content-url"))).toBe(false);
  });

  it("refuses a content URL on the app origin", async () => {
    server.use(
      http.get("*/api/v1/artifacts/:id/content-url", () =>
        HttpResponse.json({
          url: `${location.origin}/api/v1/me`,
          version: 1,
          expiresAt: null,
        }),
      ),
    );
    mount(viewerPath(OWNED));
    await screen.findByRole("button", { name: /More actions/ });
    await wait(50);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("a background refetch that bumps currentVersion does not reload the doc", async () => {
    const { client } = mount(viewerPath(OWNED));
    const first = await frame();
    const a = fixtures.artifacts.find((x) => x.id === OWNED);
    await act(async () => {
      client.setQueryData(["artifact", OWNED], { ...a, currentVersion: 3 });
      await wait(20);
    });
    expect(first.isConnected).toBe(true);
  });

  it("double-clicking Delete sends one DELETE", async () => {
    let deletes = 0;
    server.use(
      http.delete("*/api/v1/artifacts/:id", () => {
        deletes++;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    mount(viewerPath(OWNED));
    await frame();
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), {
      key: "Enter",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const btn = await screen.findByRole("button", { name: "Delete" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await wait(50);
    expect(deletes).toBe(1);
  });

  it("Download entry exists for a version beyond the first versions page", async () => {
    mount(viewerPath(SCRIPT, 1));
    await frame();
    await wait(50);
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), {
      key: "Enter",
    });
    await screen.findByRole("menuitem", { name: "Copy link" });
    expect(
      screen.queryByRole("menuitem", { name: "Download entry" }),
    ).not.toBeNull();
  });

  it("version button's accessible name contains its visible text (WCAG 2.5.3)", async () => {
    mount(viewerPath(OWNED));
    await frame();
    expect(
      screen.getByRole("button", { name: /^Version.*v2/ }),
    ).toBeInTheDocument();
  });

  it("authed + 404 on the artifact shows NotFound, no redirect", async () => {
    artifactIs(404, "not_found");
    const { redirect } = mount(viewerPath(OWNED));
    await screen.findByText("Page not found");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("other load errors show an error panel with Retry", async () => {
    let fail = true;
    server.use(
      http.get("*/api/v1/artifacts/:id", () =>
        fail
          ? err(500, "internal")
          : HttpResponse.json(fixtures.artifacts.find((a) => a.id === OWNED)),
      ),
    );
    mount(viewerPath(OWNED));
    // The query client retries 5xx twice before surfacing the error.
    const retry = await screen.findByRole(
      "button",
      { name: "Retry" },
      { timeout: 5000 },
    );
    fail = false;
    fireEvent.click(retry);
    await frame();
  }, 10_000);

  it("Copy link writes origin + viewer path to the clipboard", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    mount(viewerPath(OWNED, 2));
    await frame();
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), {
      key: "Enter",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(location.origin + viewerPath(OWNED));
  });

  it("Download entry saves the version's entry file", async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        hrefs.push(this.getAttribute("href") ?? "");
      });
    const hrefs: string[] = [];
    mount(viewerPath(OWNED, 2));
    await frame();
    await wait(50);
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), {
      key: "Enter",
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Download entry" }),
    );
    expect(hrefs).toEqual([R.versionFile(OWNED, 2, "index.html")]);
    click.mockRestore();
  });

  it("confirming Delete sends DELETE and navigates to the library", async () => {
    const { router } = mount(viewerPath(OWNED));
    await frame();
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), {
      key: "Enter",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("cancelling the Delete dialog sends nothing", async () => {
    let deletes = 0;
    server.use(
      http.delete("*/api/v1/artifacts/:id", () => {
        deletes++;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    mount(viewerPath(OWNED));
    await frame();
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), {
      key: "Enter",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await screen.findByRole("button", { name: "Delete" });
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await wait(50);
    expect(deletes).toBe(0);
  });
});

describe("full screen (#290)", () => {
  const full = (aid: string) => `${viewerPath(aid)}/full`;

  it("renders the frame alone: no crumbs, title bar or panel", async () => {
    mount(`${full(OWNED)}?panel=open&tab=share`);
    await frame();
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("anonymous + 404 redirects to sign-in, back to the full-screen view", async () => {
    anonymous();
    artifactIs(404, "not_found");
    const { redirect } = mount(full(OWNED));
    await waitFor(() =>
      expect(redirect).toHaveBeenCalledWith(login(full(OWNED))),
    );
  });

  it("signed in + 404 shows not found", async () => {
    artifactIs(404, "not_found");
    mount(full(OWNED));
    expect(
      await screen.findByRole("heading", { name: "Page not found" }),
    ).toBeInTheDocument();
  });
});
