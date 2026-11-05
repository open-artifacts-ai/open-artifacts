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
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeQueryClient } from "../src/api/queryClient";
import { RedirectProvider } from "../src/auth/redirect";
import { createAppRouter } from "../src/router";
import { LINGER_MS, REVEAL_MS, TAP_MS } from "../src/viewer/FullScreenEscape";
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
const coarse = (matches: boolean) =>
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query === "(pointer: coarse)" && matches,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );

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

describe("full-screen chip, top level", () => {
  it("is widened for 3 s on load, then collapses, with a stable name", async () => {
    mount(FULL);
    const a = await chip();
    expect(a).toHaveAttribute("href", viewerPath(OWNED));
    expect(a).not.toHaveAttribute("target");
    expect(a).toHaveAttribute("data-open", "true");
    expect(a).toHaveTextContent("Exit full screen");
    await tick(REVEAL_MS);
    expect(a).toHaveAttribute("data-open", "false");
    // The label stays in the DOM, so the accessible name never changes.
    expect(a).toHaveTextContent("Exit full screen");
    expect(a).toHaveAccessibleName(TOP);
    expect(a.querySelector("img")).toHaveAttribute("aria-hidden", "true");
  });

  it("comes after the frame in the document", async () => {
    mount(FULL);
    const a = await chip();
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    expect(
      frame.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("widens on hover and collapses 400 ms after the pointer leaves", async () => {
    mount(FULL);
    const a = await chip();
    await tick(REVEAL_MS);
    fireEvent.pointerEnter(a, { pointerType: "mouse" });
    expect(a).toHaveAttribute("data-open", "true");
    await tick(REVEAL_MS * 2);
    expect(a).toHaveAttribute("data-open", "true");
    fireEvent.pointerLeave(a, { pointerType: "mouse" });
    await tick(LINGER_MS - 50);
    expect(a).toHaveAttribute("data-open", "true");
    await tick(50);
    expect(a).toHaveAttribute("data-open", "false");
  });

  it("widens on keyboard focus and collapses 400 ms after focus moves", async () => {
    mount(FULL);
    const a = await chip();
    await tick(REVEAL_MS);
    act(() => a.focus());
    expect(a).toHaveAttribute("data-open", "true");
    act(() => a.blur());
    await tick(LINGER_MS);
    expect(a).toHaveAttribute("data-open", "false");
  });

  it("coarse pointer: the first tap widens without navigating, the second follows", async () => {
    coarse(true);
    const router = mount(FULL);
    const a = await chip();
    await tick(REVEAL_MS);
    fireEvent.click(a);
    expect(a).toHaveAttribute("data-open", "true");
    expect(router.state.location.pathname).toBe(FULL);
    await tick(TAP_MS - 100);
    expect(a).toHaveAttribute("data-open", "true");
    fireEvent.click(a);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(viewerPath(OWNED)),
    );
  });

  it("coarse pointer: a tap after the 4 s widen collapsed it is a first tap again", async () => {
    coarse(true);
    const router = mount(FULL);
    const a = await chip();
    await tick(REVEAL_MS);
    fireEvent.click(a);
    await tick(TAP_MS);
    expect(a).toHaveAttribute("data-open", "false");
    fireEvent.click(a);
    expect(router.state.location.pathname).toBe(FULL);
  });

  it("a fine pointer follows on the first click", async () => {
    const router = mount(FULL);
    const a = await chip();
    await tick(REVEAL_MS);
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

describe("full-screen chip, embedded", () => {
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

  it("opens in a new tab, rests collapsed and ignores Esc", async () => {
    const router = mount(FULL);
    const a = await chip(EMBED);
    expect(a).toHaveAttribute("href", viewerPath(OWNED));
    expect(a).toHaveAttribute("target", "_blank");
    expect(a).toHaveAttribute("rel", "noopener");
    expect(a).toHaveTextContent("Open in Open Artifacts");
    expect(a.querySelector("svg.oa-fsx-arrow")).not.toBeNull();
    expect(a).toHaveAttribute("data-open", "false");
    fireEvent.keyDown(document, { key: "Escape" });
    await tick(REVEAL_MS);
    expect(router.state.location.pathname).toBe(FULL);
    fireEvent.pointerEnter(a, { pointerType: "mouse" });
    expect(a).toHaveAttribute("data-open", "true");
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
