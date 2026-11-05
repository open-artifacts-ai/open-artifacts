// #471: one versions control (Design tZY2i1Wteaa7Ltge v2, option B). The
// version chip toggles the Versions panel; the panel has search, compact rows,
// Current first, paging on scroll and roving focus.
import { viewerPath } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { exactDate, versionDate } from "../src/viewer/versionDate";
import { installHarness, intersect, mount, seen } from "./harness";

vi.mock("../src/viewer/bridge", () => ({
  createBridge: () => ({
    dispose: vi.fn(),
    requestThumbnail: vi.fn(),
    setTheme: vi.fn(),
    setArtifact: vi.fn(),
  }),
}));

installHarness();

const id = (title: string) =>
  (fixtures.artifacts.find((a) => a.title === title) as { id: string }).id;
const OWNED = id("Landing page");
const SCRIPT = id("Parser script");
const panel = (aid: string, v?: number) =>
  `${viewerPath(aid, v)}?panel=open&tab=versions`;

const chip = () => screen.findByRole("button", { name: /^Version: v/ });
const list = () => screen.findByRole("list", { name: "Versions" });
const rows = async () => within(await list()).getAllByRole("button");
const row = async (v: number) =>
  within(await list()).getByRole("button", {
    name: new RegExp(`^v${v}, `),
  });
const searchBox = () =>
  screen.findByRole("searchbox", { name: "Search versions" });
const type = async (q: string) =>
  fireEvent.change(await searchBox(), { target: { value: q } });

describe("the version chip", () => {
  it("toggles the Versions panel and focuses search", async () => {
    const router = mount(viewerPath(OWNED));
    const c = await chip();
    expect(c).toHaveTextContent("v2 · Current");
    expect(c).toHaveAttribute("aria-expanded", "false");
    c.focus();
    fireEvent.click(c);
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        panel: "open",
        tab: "versions",
      }),
    );
    expect(c).toHaveAttribute("aria-expanded", "true");
    const controls = c.getAttribute("aria-controls");
    expect(controls && document.getElementById(controls)).toBeTruthy();
    await waitFor(async () => expect(await searchBox()).toHaveFocus());
    fireEvent.click(c);
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ panel: "closed" }),
    );
    await waitFor(() => expect(c).toHaveFocus());
  });

  it("switches an open panel to Versions instead of closing it", async () => {
    const router = mount(`${viewerPath(OWNED)}?panel=open&tab=share`);
    const c = await chip();
    expect(c).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(c);
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        panel: "open",
        tab: "versions",
      }),
    );
  });

  it("says how old a pinned version is", async () => {
    mount(viewerPath(OWNED, 1));
    // The chip exists before the version list arrives and says only "v1" until
    // then: wait for the date, re-reading the chip each time.
    // The row rule: relative under a week, else "Jan 2" (plus a year if not this one).
    await chip();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Version: v/ }),
      ).toHaveTextContent(/^v1 · Jan 2(, 2026)?$/),
    );
  });

  it("replaces the dropdown and the separate Versions button", async () => {
    mount(viewerPath(OWNED));
    fireEvent.pointerDown(await chip(), { button: 0, pointerType: "mouse" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("button", { name: "Versions" })).toBeNull();
  });
});

describe("rows", () => {
  it("are buttons named with version, date, message and author; Current first", async () => {
    mount(panel(OWNED));
    const [first, second] = await rows();
    expect(first).toHaveAccessibleName(
      /^v2, Current, .+, .+ at .+, Update 2, Claude Code$/,
    );
    expect(first).toHaveAttribute("aria-current", "true");
    expect(second).toHaveAccessibleName(/^v1, .+, Initial version, /);
    expect(second).not.toHaveAttribute("aria-current");
  });

  it("only the viewed row shows its actions", async () => {
    mount(panel(OWNED, 1));
    const v1 = (await row(1)).closest("li") as HTMLElement;
    expect(
      within(v1).getByRole("link", { name: "Compare with current" }),
    ).toBeVisible();
    expect(within(v1).getByRole("button", { name: "Restore" })).toBeVisible();
    expect(within(v1).getByRole("link", { name: "View" })).toBeVisible();
    const v2 = (await row(2)).closest("li") as HTMLElement;
    expect(within(v2).queryByRole("link", { name: "View" })).toBeNull();
    expect(within(v2).queryByRole("button", { name: "Restore" })).toBeNull();
  });

  it("viewing Current, its row has no actions (no lone View)", async () => {
    mount(panel(OWNED));
    const v2 = (await row(2)).closest("li") as HTMLElement;
    expect(await row(2)).toHaveAttribute("aria-current", "true");
    expect(within(v2).queryByRole("link")).toBeNull();
  });

  it("a click opens that version and keeps the panel open", async () => {
    const router = mount(panel(OWNED));
    fireEvent.click(await row(1));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(viewerPath(OWNED, 1)),
    );
    expect(router.state.location.search).toMatchObject({
      panel: "open",
      tab: "versions",
    });
    // Current follows the latest again.
    fireEvent.click(await row(2));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(viewerPath(OWNED)),
    );
  });

  it("arrow keys, Home and End move focus; one row is in the tab order", async () => {
    mount(panel(SCRIPT));
    await screen.findByText("Update 6");
    const all = await rows();
    expect(all.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    fireEvent.keyDown(await searchBox(), { key: "ArrowDown" });
    expect(all[0]).toHaveFocus();
    fireEvent.keyDown(all[0], { key: "ArrowDown" });
    expect(all[1]).toHaveFocus();
    fireEvent.keyDown(all[1], { key: "End" });
    expect(all[all.length - 1]).toHaveFocus();
    fireEvent.keyDown(all[all.length - 1], { key: "Home" });
    expect(all[0]).toHaveFocus();
    fireEvent.keyDown(all[0], { key: "ArrowUp" });
    expect(all[0]).toHaveFocus();
  });
});

describe("search", () => {
  it("filters loaded versions by message and counts matches politely", async () => {
    mount(panel(SCRIPT));
    await screen.findByText("Update 6");
    await type("Update 1");
    // Loaded: 25 to 6; Update 10 to 19 match.
    const status = await screen.findByText("10 of 25 match");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(await rows()).toHaveLength(10);
    expect(screen.getAllByText("Update 1", { selector: "mark" })).toHaveLength(
      10,
    );
  });

  it("matches the author or agent", async () => {
    mount(panel(OWNED));
    await screen.findByText("Initial version");
    await type("nobody-by-that-name");
    expect(screen.queryByRole("list", { name: "Versions" })).toBeNull();
    await type(fixtures.versions[OWNED][0].agent?.name ?? "");
    expect(await rows()).toHaveLength(2);
  });

  it("a loaded version number jumps to that version", async () => {
    mount(panel(SCRIPT));
    await screen.findByText("Update 6");
    await type("v12");
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toHaveAccessibleName(/^v12, /);
    await type("12");
    expect(await rows()).toHaveLength(1);
  });

  it("an unloaded version number fetches just that version", async () => {
    mount(panel(SCRIPT));
    await screen.findByText("Update 6");
    await type("v3");
    expect(await screen.findByText("Update 3")).toBeVisible();
    expect(seen.some((u) => u.searchParams.get("before") === "4")).toBe(true);
    expect(screen.getByText("Jumped to v3 (not loaded yet).")).toBeVisible();
  });

  it("nothing loaded matches: offers to search older versions", async () => {
    mount(panel(SCRIPT));
    await screen.findByText("Update 6");
    await type("Update 5");
    expect(
      screen.getByText('No loaded version mentions "Update 5".'),
    ).toBeVisible();
    expect(screen.queryByText(/^0 of \d+ match$/)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /^Search older versions/ }),
    );
    expect(await screen.findByText("Update 5")).toBeVisible();
    expect(seen.some((u) => u.searchParams.get("before") === "6")).toBe(true);
  });

  it("Escape clears the search, then closes the panel", async () => {
    const router = mount(panel(OWNED));
    const box = await searchBox();
    await type("Initial");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box).toHaveValue("");
    expect(router.state.location.search).toMatchObject({ panel: "open" });
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ panel: "closed" }),
    );
  });

  it("/ focuses search", async () => {
    mount(panel(OWNED));
    const first = (await rows())[0];
    first.focus();
    fireEvent.keyDown(first, { key: "/" });
    expect(await searchBox()).toHaveFocus();
  });
});

describe("paging", () => {
  it("loads older versions when the end scrolls into view", async () => {
    mount(panel(SCRIPT));
    await screen.findByText("Update 6");
    intersect();
    expect(await screen.findByText("Update 5")).toBeVisible();
    expect(seen.some((u) => u.searchParams.get("before") === "6")).toBe(true);
  });
});

describe("versionDate", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  it("is relative under a week", () => {
    expect(versionDate("2026-10-23T10:00:00Z", now)).toBe("2 hours ago");
    expect(versionDate("2026-10-22T10:00:00Z", now)).toBe("yesterday");
  });
  it("is a short date after a week, with the year only when it differs", () => {
    expect(versionDate("2026-10-12T10:00:00Z", now)).toBe("Oct 12");
    expect(versionDate("2025-10-12T10:00:00Z", now)).toBe("Oct 12, 2025");
  });
  it("exactDate reads as a sentence", () => {
    expect(exactDate("2026-10-22T15:10:00Z", now)).toMatch(
      /^October 22 at \d{1,2}:10 (AM|PM)$/,
    );
    expect(exactDate("2025-10-22T15:10:00Z", now)).toMatch(
      /^October 22, 2025 at /,
    );
  });
});
