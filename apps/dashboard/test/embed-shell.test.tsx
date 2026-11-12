// Embed mode through the real router and Shell: anonymous, no /me, no
// sign-in redirect; private content shows the not-public panel.
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { makeQueryClient } from "../src/api/queryClient";
import { RedirectProvider } from "../src/auth/redirect";
import { setEmbedForTests } from "../src/embed";
import { createAppRouter } from "../src/router";
import { arts, installHarness, seen, server } from "./harness";

installHarness();

// msw's patched fetch, under the harness shim (which always adds the cookie).
let realFetch: typeof fetch;
beforeAll(() => {
  vi.unstubAllGlobals();
  realFetch = globalThis.fetch;
});
/** Like a browser: the session cookie rides along unless credentials is "omit". */
const credentialed: RequestInit[] = [];
beforeEach(() => {
  credentialed.length = 0;
  setEmbedForTests(true);
  vi.stubGlobal("fetch", (u: RequestInfo | URL, init?: RequestInit) => {
    const omit = init?.credentials === "omit";
    if (!omit && init) credentialed.push(init);
    return realFetch(new URL(u as string, "http://localhost").href, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string>),
        ...(omit ? {} : { cookie: "oa_session=test" }),
      },
    });
  });
});
afterEach(() => setEmbedForTests(false));

/** As the server does (the shared mocks don't): anonymous reads of a non-public artifact 404. */
const privateIs404 = () =>
  server.use(
    http.get("*/api/v1/artifacts/:id/*", ({ request, params }) =>
      anonPrivate(request, params.id),
    ),
    http.get("*/api/v1/artifacts/:id", ({ request, params }) =>
      anonPrivate(request, params.id),
    ),
  );
const anonPrivate = (request: Request, id: unknown) => {
  const a = arts.find((x) => x.id === id);
  if (request.headers.has("cookie") || !a || a.visibility === "public")
    return undefined;
  return HttpResponse.json(
    { error: { code: "not_found", message: "Not found" } },
    { status: 404 },
  );
};

const mount = (path: string) => {
  const redirect = vi.fn();
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <RedirectProvider value={redirect}>
        <RouterProvider
          router={createAppRouter(
            createMemoryHistory({ initialEntries: [path] }),
          )}
        />
      </RedirectProvider>
    </QueryClientProvider>,
  );
  return redirect;
};
const byTitle = (t: string) => {
  const a = arts.find((x) => x.title === t);
  if (!a) throw new Error(t);
  return a;
};

describe("embed mode", () => {
  it("a private artifact shows the not-public panel, never a sign-in redirect", async () => {
    privateIs404();
    const { id } = byTitle("Landing page"); // private
    const redirect = mount(`/a/${id}/full`);
    await screen.findByRole("heading", { name: "This artifact isn't public" });
    const link = screen.getByRole("link", { name: "Open in Open Artifacts" });
    expect(link).toHaveAttribute("href", `/a/${id}`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener");
    expect(redirect).not.toHaveBeenCalled();
    expect(seen.some((u) => u.pathname === "/api/v1/me")).toBe(false);
    expect(credentialed).toEqual([]);
  });

  it("a public artifact renders anonymously, with no /me and no credentials", async () => {
    const { id, title } = byTitle("Team poll"); // public
    const redirect = mount(`/a/${id}/full`);
    expect(await screen.findByTitle(title)).toBeInstanceOf(HTMLIFrameElement);
    expect(redirect).not.toHaveBeenCalled();
    expect(seen.some((u) => u.pathname === "/api/v1/me")).toBe(false);
    expect(credentialed).toEqual([]);
  });

  it("any other route renders the panel, not the app", async () => {
    const redirect = mount("/settings/profile");
    await screen.findByRole("heading", { name: "This artifact isn't public" });
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
    expect(credentialed).toEqual([]);
  });
});
