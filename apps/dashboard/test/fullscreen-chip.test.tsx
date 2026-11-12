// #290, option A: the full-screen view's peek chip, and Full screen's icon.
import { viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeQueryClient } from "../src/api/queryClient";
import { RedirectProvider } from "../src/auth/redirect";
import { createAppRouter } from "../src/router";
import { installHarness } from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: () => {},
    requestThumbnail: () => {},
    setTheme: () => {},
    setArtifact: () => {},
  }),
}));

installHarness();

const OWNED = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as { id: string }
).id;
const FULL = `${viewerPath(OWNED)}/full`;
const TOP = "Exit full screen, back to Landing page";
const EMBED = "Open Landing page in Open Artifacts (opens in new tab)";

const mount = (path: string) => {
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [path] }),
  );
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <RedirectProvider value={vi.fn()}>
        <RouterProvider router={router} />
      </RedirectProvider>
    </QueryClientProvider>,
  );
  return router;
};
const chip = (name = TOP) => screen.findByRole("link", { name });
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout"],
    shouldAdvanceTime: true,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("full-screen controls, top level", () => {
  it("Exit is an icon with a stable name, in the group with Comments", async () => {
    mount(FULL);
    const a = await chip();
    expect(a).toHaveAttribute("href", viewerPath(OWNED));
    expect(a).not.toHaveAttribute("target");
    expect(a).toHaveAccessibleName(TOP);
    expect(a).toHaveTextContent("");
    expect(a).not.toHaveAttribute("data-open");
    const bar = a.closest(".oa-fsbar") as HTMLElement;
    const comments = await within(bar).findByRole("button", {
      name: /^Comments/,
    });
    expect(comments.getAttribute("aria-label")).toMatch(
      /^Comments(, \d+ open)?$/,
    );
    for (const el of [a, comments])
      for (const svg of el.querySelectorAll("svg"))
        expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(comments.querySelector("svg.oa-fsicon")).not.toBeNull();
    expect(a.querySelector("svg.oa-fsicon")).not.toBeNull();
  });

  it("comes before the frame in the document, so Tab reaches it first", async () => {
    mount(FULL);
    const a = await chip();
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    expect(
      a.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("a click follows the link", async () => {
    const router = mount(FULL);
    const a = await chip();
    fireEvent.click(a);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(viewerPath(OWNED)),
    );
  });

  it("Esc goes back to the viewer", async () => {
    const router = mount(FULL);
    await chip();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(viewerPath(OWNED)),
    );
  });
});

describe("full-screen controls, embedded", () => {
  beforeEach(() => {
    Object.defineProperty(window, "self", {
      configurable: true,
      value: {},
    });
  });
  afterEach(() => {
    Object.defineProperty(window, "self", {
      configurable: true,
      value: window,
    });
  });

  it("opens in a new tab as an icon and ignores Esc", async () => {
    const router = mount(FULL);
    const a = await chip(EMBED);
    expect(a).toHaveAttribute("href", viewerPath(OWNED));
    expect(a).toHaveAttribute("target", "_blank");
    expect(a).toHaveAttribute("rel", "noopener");
    expect(a).toHaveTextContent("");
    expect(a.querySelector("svg.oa-fsicon")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    await tick(100);
    expect(router.state.location.pathname).toBe(FULL);
    expect(a).toHaveAccessibleName(EMBED);
  });
});

describe("Full screen icon", () => {
  it("is on the title bar button and the ••• menu item", async () => {
    vi.useRealTimers();
    mount(viewerPath(OWNED));
    const link = await screen.findByRole("link", { name: "Full screen" });
    expect(link.querySelector("svg.lucide-maximize-2")).not.toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "More actions" }), {
      key: "Enter",
    });
    const item = await screen.findByRole("menuitem", { name: "Full screen" });
    expect(item.querySelector("svg.lucide-maximize-2")).not.toBeNull();
  });
});
