// #2860: Mute where the noise is: a page's ⋯ menu in the viewer, and the asking
// agent on a For you ask card. A mute stops push only.
import { R, viewerPath } from "@oa/shared";
import { createHandlers, fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { calls, events, installHarness, mount, server } from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
    setArtifact: vi.fn(),
  }),
}));

installHarness();

// The title bar measures itself; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const OWNED = (
  fixtures.artifacts.find((a) => a.title === "Landing page") as {
    id: string;
  }
).id;
const forYou = (...first: Parameters<typeof server.use>) =>
  server.use(...first, ...createHandlers({ events, forYou: "mixed" }));

const openMenu = async () => {
  fireEvent.keyDown(
    await screen.findByRole(
      "button",
      { name: "More actions" },
      { timeout: FIRST_LOAD_MS },
    ),
    { key: "Enter" },
  );
  return screen.findByRole("menu");
};

describe("Mute in the viewer's page menu", () => {
  it("mutes the page, says so with Undo, and the item turns into Muted · Unmute", async () => {
    const posts = calls("POST");
    forYou();
    mount(viewerPath(OWNED));
    const menu = await openMenu();
    fireEvent.click(
      await within(menu).findByRole("menuitem", { name: "Mute" }),
    );
    await waitFor(() =>
      expect(posts.find((c) => c.path === R.meInboxMutes)?.body).toEqual({
        kind: "page",
        id: OWNED,
      }),
    );
    expect(
      await screen.findByText(
        /Muted "Landing page"\. Its asks still show in For you\./,
      ),
    ).toBeInTheDocument();
    const again = await openMenu();
    expect(
      await within(again).findByRole("menuitem", { name: "Muted · Unmute" }),
    ).toBeInTheDocument();
  });

  it("Unmute removes the mute", async () => {
    const dels = calls("DELETE");
    forYou();
    mount(viewerPath(OWNED));
    let menu = await openMenu();
    fireEvent.click(
      await within(menu).findByRole("menuitem", { name: "Mute" }),
    );
    await screen.findByText(/Muted "Landing page"/);
    menu = await openMenu();
    fireEvent.click(
      await within(menu).findByRole("menuitem", { name: "Muted · Unmute" }),
    );
    await waitFor(() =>
      expect(dels.some((c) => c.path === R.meInboxMute("page", OWNED))).toBe(
        true,
      ),
    );
    expect(
      await screen.findByText("Unmuted Landing page."),
    ).toBeInTheDocument();
  });

  it("a refused mute says why in plain words", async () => {
    forYou(
      http.post(`*${R.meInboxMutes}`, () =>
        HttpResponse.json(
          { error: { code: "mutes_full", message: "x" } },
          { status: 400 },
        ),
      ),
    );
    mount(viewerPath(OWNED));
    const menu = await openMenu();
    fireEvent.click(
      await within(menu).findByRole("menuitem", { name: "Mute" }),
    );
    expect(
      await screen.findByText(/You've muted as many as we allow \(200\)\./),
    ).toBeInTheDocument();
  });

  it("is absent on a server without For you", async () => {
    mount(viewerPath(OWNED));
    const menu = await openMenu();
    await within(menu).findByRole("menuitem", { name: "Copy link" });
    expect(within(menu).queryByRole("menuitem", { name: "Mute" })).toBeNull();
  });
});

describe("Mute the asking agent on a For you ask card", () => {
  it("offers Mute <agent> and posts kind agent with its key", async () => {
    const posts = calls("POST");
    forYou();
    mount("/");
    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: /^For you/ },
        { timeout: FIRST_LOAD_MS },
      ),
    );
    const panel = await screen.findByRole("dialog", { name: "For you" });
    fireEvent.click(
      await within(panel).findByRole("button", {
        name: "Ship the landing with the waitlist?",
      }),
    );
    fireEvent.click(
      await within(panel).findByRole("button", { name: "Mute OA Manager" }),
    );
    await waitFor(() =>
      expect(posts.find((c) => c.path === R.meInboxMutes)?.body).toEqual({
        kind: "agent",
        id: "agent:manager",
      }),
    );
    expect(
      await within(panel).findByRole("button", { name: "Muted · Unmute" }),
    ).toBeInTheDocument();
  });
});
