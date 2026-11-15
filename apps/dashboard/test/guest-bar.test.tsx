// #2590 slice 2: the guest bar, the "Get your own" offer and a guest's home.
// `sharedBy` on GET R.artifact is PROVISIONAL (OA Backend's draft contract).
import { R } from "@oa/shared";
import { fixtures } from "@oa/shared/mocks";
import {
  act,
  fireEvent,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import {
  HOSTED_OFFER_URL,
  offerUrl,
  SELF_HOSTED_OFFER_URL,
  useFirstCommentOffer,
} from "../src/viewer/guest";
import { installHarness, mount, server } from "./harness";
import { FIRST_LOAD_MS } from "./timeouts";

installHarness();

const NOTES = "De6gHjKmNp7qRsTu";
const asGuest = (sharedBy: { name: string } | null, hosted = false) =>
  server.use(
    http.get("*/api/v1/me", () =>
      HttpResponse.json({
        ...fixtures.me,
        user: { ...fixtures.me.user, role: "guest" },
        instance: { ...fixtures.me.instance, hosted },
      }),
    ),
    http.get(`*${R.artifact(NOTES)}`, () =>
      HttpResponse.json({
        ...fixtures.artifacts.find((x) => x.id === NOTES),
        sharedBy,
      }),
    ),
  );

describe("the guest bar", () => {
  it("says who shared it and that you're a guest, with Open Artifacts as a link", async () => {
    asGuest({ name: "Ada Lovelace" });
    mount(`/a/${NOTES}`);
    const bar = await screen.findByText(
      "Shared by Ada Lovelace · You're a guest",
      undefined,
      { timeout: FIRST_LOAD_MS },
    );
    const header = bar.closest("[data-guest-bar]") as HTMLElement;
    const home = within(header).getByRole("link", { name: "Open Artifacts" });
    expect(home).toHaveAttribute("href", "https://open-artifacts.com");
    expect(home).toHaveAttribute("target", "_blank");
    expect(home).toHaveAttribute("rel", "noopener");
    expect(
      within(header).getByRole("button", { name: "Guest options" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  });

  it("Get your own in the menu: sign-up on hosted, in a new tab", async () => {
    asGuest({ name: "Ada Lovelace" }, true);
    mount(`/a/${NOTES}`);
    const menu = await screen.findByRole(
      "button",
      { name: "Guest options" },
      { timeout: FIRST_LOAD_MS },
    );
    fireEvent.pointerDown(menu, { button: 0, pointerType: "mouse" });
    const item = await screen.findByRole("menuitem", { name: "Get your own" });
    expect(item).toHaveAttribute("href", "https://signup.open-artifacts.app/");
    expect(item).toHaveAttribute("target", "_blank");
    expect(item).toHaveAttribute("rel", "noopener");
  });

  it("with no sender, says only that you're a guest", async () => {
    asGuest(null);
    mount(`/a/${NOTES}`);
    expect(
      await screen.findByText("You're a guest", undefined, {
        timeout: FIRST_LOAD_MS,
      }),
    ).toBeInTheDocument();
  });

  it("members keep the breadcrumbs", async () => {
    mount(`/a/${NOTES}`);
    expect(
      await screen.findByRole(
        "navigation",
        { name: "Breadcrumb" },
        { timeout: FIRST_LOAD_MS },
      ),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-guest-bar]")).toBeNull();
  });
});

describe("Get your own", () => {
  it("goes to sign-up when hosted, the public site when self-hosted", () => {
    expect(offerUrl(true)).toBe("https://signup.open-artifacts.app/");
    expect(offerUrl(false)).toBe("https://open-artifacts.com");
    expect(HOSTED_OFFER_URL).not.toMatch(/[?#]/);
    expect(SELF_HOSTED_OFFER_URL).not.toMatch(/[?#]/);
  });

  describe("after the first comment", () => {
    beforeEach(() => localStorage.clear());

    it("shows once the guest's own comments go from none to one", () => {
      const h = renderHook(({ n }) => useFirstCommentOffer(true, n), {
        initialProps: { n: 0 as number | null },
      });
      expect(h.result.current.show).toBe(false);
      h.rerender({ n: 1 });
      expect(h.result.current.show).toBe(true);
      act(() => h.result.current.dismiss());
      expect(h.result.current.show).toBe(false);
      h.rerender({ n: 2 });
      expect(h.result.current.show).toBe(false);
    });

    it("never twice on this browser", () => {
      const a = renderHook(({ n }) => useFirstCommentOffer(true, n), {
        initialProps: { n: 0 as number | null },
      });
      a.rerender({ n: 1 });
      expect(a.result.current.show).toBe(true);
      const b = renderHook(({ n }) => useFirstCommentOffer(true, n), {
        initialProps: { n: 0 as number | null },
      });
      b.rerender({ n: 1 });
      expect(b.result.current.show).toBe(false);
    });

    it("not for a guest who had commented before, nor for a member", () => {
      const before = renderHook(({ n }) => useFirstCommentOffer(true, n), {
        initialProps: { n: 2 as number | null },
      });
      before.rerender({ n: 3 });
      expect(before.result.current.show).toBe(false);
      const member = renderHook(({ n }) => useFirstCommentOffer(false, n), {
        initialProps: { n: 0 as number | null },
      });
      member.rerender({ n: 1 });
      expect(member.result.current.show).toBe(false);
    });

    it("waits for the comments to load before counting", () => {
      const h = renderHook(({ n }) => useFirstCommentOffer(true, n), {
        initialProps: { n: null as number | null },
      });
      // Loaded with one already: that comment came before this visit.
      h.rerender({ n: 1 });
      h.rerender({ n: 2 });
      expect(h.result.current.show).toBe(false);
    });
  });
});

describe("a guest's home", () => {
  it("is Shared with you, with no tab strip", async () => {
    asGuest(null);
    mount("/shared");
    expect(
      await screen.findByRole(
        "heading",
        { level: 1, name: "Shared with you" },
        { timeout: FIRST_LOAD_MS },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Shared with you" }),
    ).toBeInTheDocument();
  });
});
