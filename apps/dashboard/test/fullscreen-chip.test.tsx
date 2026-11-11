// #290, option A: the full-screen view's peek chip, and Full screen's icon.
import { viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import {
  act,
  cleanup,
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
import { NEAR_PX } from "../src/viewer/FullScreenEscape";
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
    toFake: ["setTimeout", "clearTimeout", "Date"],
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

  it("is near when the pointer is within NEAR_PX of the group, and clears on leave", async () => {
    mount(FULL);
    const a = await chip();
    const bar = a.closest(".oa-fsbar") as HTMLElement;
    vi.spyOn(bar, "getBoundingClientRect").mockReturnValue({
      left: 900,
      right: 1000,
      top: 8,
      bottom: 40,
      width: 100,
      height: 32,
      x: 900,
      y: 8,
      toJSON: () => ({}),
    });
    expect(bar).toHaveAttribute("data-near", "false");
    fireEvent.pointerMove(document, {
      clientX: 900 - NEAR_PX + 1,
      clientY: 40,
      pointerType: "mouse",
    });
    expect(bar).toHaveAttribute("data-near", "true");
    await tick(100);
    fireEvent.pointerMove(document, {
      clientX: 900 - NEAR_PX - 20,
      clientY: 40,
      pointerType: "mouse",
    });
    expect(bar).toHaveAttribute("data-near", "false");
    await tick(100);
    fireEvent.pointerMove(document, { clientX: 950, clientY: 20 });
    expect(bar).toHaveAttribute("data-near", "true");
    fireEvent.pointerLeave(document.documentElement);
    expect(bar).toHaveAttribute("data-near", "false");
  });

  it("stops listening when it unmounts", async () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const { unmount } = (() => {
      mount(FULL);
      return { unmount: () => cleanup() };
    })();
    await chip();
    unmount();
    expect(remove.mock.calls.some(([t]) => t === "pointermove")).toBe(true);
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
