// #2112, option B: the full-screen view's strip, and Full screen's icon.
import { viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import {
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
const TOP = "Exit full screen";
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
afterEach(() => {
  vi.restoreAllMocks();
});

describe("full-screen strip, top level", () => {
  it("shows the title and the exit link with a stable name", async () => {
    mount(FULL);
    const a = await chip();
    expect(a).toHaveAttribute("href", viewerPath(OWNED));
    expect(a).not.toHaveAttribute("target");
    expect(a).not.toHaveAttribute("data-open");
    expect(a).toHaveTextContent("Exit full screen");
    expect(a).toHaveAccessibleName(TOP);
    const bar = a.closest(".oa-fsbar") as HTMLElement;
    expect(bar.querySelector(".oa-fstitle")).toHaveTextContent("Landing page");
    expect(a.querySelector("svg.oa-fsx-x")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("orders title, Comments, then the exit link; icons are hidden from AT", async () => {
    mount(FULL);
    const a = await chip();
    const bar = a.closest(".oa-fsbar") as HTMLElement;
    const comments = await within(bar).findByRole("button", {
      name: /^Comments/,
    });
    const title = bar.querySelector(".oa-fstitle") as HTMLElement;
    const follows = (x: Node, y: Node) =>
      !!(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(title, comments)).toBe(true);
    expect(follows(comments, a)).toBe(true);
    expect(comments.getAttribute("aria-label")).toMatch(
      /^Comments(, \d+ open)?$/,
    );
    for (const el of [a, comments])
      for (const svg of el.querySelectorAll("svg"))
        expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(comments.querySelector("svg.oa-fsicon")).not.toBeNull();
  });

  it("comes after the frame in the document", async () => {
    mount(FULL);
    const a = await chip();
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    expect(
      frame.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("a click follows to the viewer", async () => {
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

describe("full-screen strip, embedded", () => {
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

  it("shows the title and one link that opens in a new tab; ignores Esc", async () => {
    const router = mount(FULL);
    const a = await chip(EMBED);
    expect(a).toHaveAttribute("href", viewerPath(OWNED));
    expect(a).toHaveAttribute("target", "_blank");
    expect(a).toHaveAttribute("rel", "noopener");
    expect(a).toHaveTextContent("Open in Open Artifacts");
    expect(a.querySelector("svg.oa-fsx-arrow")).not.toBeNull();
    expect(a).toHaveAccessibleName(EMBED);
    expect(
      (a.closest(".oa-fsbar") as HTMLElement).querySelector(".oa-fstitle"),
    ).toHaveTextContent("Landing page");
    fireEvent.keyDown(document, { key: "Escape" });
    await new Promise((r) => setTimeout(r, 50));
    expect(router.state.location.pathname).toBe(FULL);
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
