// Under prefers-reduced-motion the shadcn overlays open and close without
// their zoom/slide/fade, the sidebar collapses without sliding, and sonner's
// toasts don't animate. Each check flips back to no-preference on the same
// page to prove the motion was there to remove.
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch, openStory, settled } from "./harness";

const A11Y = "shadcn-a11y--shadcn-a11y-fixture";
const SIDEBAR = "shadcn-sidebar--shadcn-sidebar";
const READY_SIDEBAR = '[data-slot="sidebar-wrapper"]';

let browser: Browser;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close } = await launch());
});
afterAll(() => close?.(), 15_000);

// Animation names of every open overlay surface and backdrop (the mobile
// sidebar's sheet content carries data-slot="sidebar").
const names = (page: Page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll(
        [
          "select-content",
          "dropdown-menu-content",
          "dialog-content",
          "dialog-overlay",
          "alert-dialog-content",
          "alert-dialog-overlay",
          "tooltip-content",
          "sheet-overlay",
        ]
          .map((s) => `[data-slot="${s}"]`)
          .concat('[data-mobile="true"][role="dialog"]')
          .join(", "),
      ),
    ].map(
      (el) =>
        `${el.getAttribute("data-mobile") ? "sheet-content" : el.getAttribute("data-slot")} ${getComputedStyle(el).animationName}`,
    ),
  );

const motion = async (page: Page, reduce: boolean) => {
  await page.emulateMedia({
    reducedMotion: reduce ? "reduce" : "no-preference",
  });
  return names(page);
};

// openStory turns every transition off to measure settled styles; take
// that back out so transition-property is the component's own.
const restoreTransitions = (page: Page) =>
  page.evaluate(() => {
    for (const s of document.querySelectorAll("style"))
      if (s.textContent?.includes("transition: none !important")) s.remove();
  });

describe("shadcn under prefers-reduced-motion", () => {
  it.each([
    ["select", "combobox", "Role", '[role="listbox"]'],
    ["dropdown menu", "button", "Actions", '[role="menu"]'],
    ["dialog", "button", "Open dialog", '[role="dialog"]'],
    ["alert dialog", "button", "Delete artifact", '[role="alertdialog"]'],
  ] as const)("%s does not animate", async (_, role, label, sel) => {
    const page = await openStory(browser, A11Y, "light", "[data-a11y-ready]");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole(role, { name: label, exact: true }).first().focus();
    await page.keyboard.press("Enter");
    await settled(page, sel);
    const reduced = await names(page);
    const full = await motion(page, false);
    await page.close();
    expect(reduced.length).toBeGreaterThan(0);
    expect(reduced.filter((n) => !n.endsWith(" none"))).toEqual([]);
    expect(full.filter((n) => n.endsWith(" none"))).toEqual([]);
  });

  it("tooltip does not animate", async () => {
    const page = await openStory(browser, A11Y, "light", "[data-a11y-ready]");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const trigger = page
      .getByRole("button", { name: "Hover", exact: true })
      .first();
    // Radix closes a tooltip on scroll; scroll first (see contrast test).
    await trigger.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await trigger.focus();
    await page.waitForSelector('[data-slot="tooltip-content"]');
    const reduced = await names(page);
    const full = await motion(page, false);
    await page.close();
    expect(reduced).toEqual(["tooltip-content none"]);
    expect(full).not.toEqual(["tooltip-content none"]);
  });

  it("toasts do not animate (sonner's own reduced-motion rule)", async () => {
    const page = await openStory(browser, A11Y, "light", "[data-a11y-ready]");
    await restoreTransitions(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page
      .getByRole("button", { name: "Show toast", exact: true })
      .first()
      .click();
    const toast = page.locator("[data-sonner-toast]").first();
    await toast.waitFor();
    const read = () =>
      toast.evaluate((el) => {
        const s = getComputedStyle(el);
        return `${s.transitionDuration} ${s.animationName}`;
      });
    const reduced = await read();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const full = await read();
    await page.close();
    expect(reduced).toBe("0s none");
    expect(full).not.toBe("0s none");
  });

  it("sidebar collapses without sliding", async () => {
    const page = await openStory(browser, SIDEBAR, "light", READY_SIDEBAR);
    await restoreTransitions(page);
    const props = () =>
      page.evaluate(() =>
        [
          '[data-slot="sidebar-gap"]',
          '[data-slot="sidebar-container"]',
          '[data-sidebar="rail"]',
          '[data-sidebar="group-label"]',
          '[data-sidebar="menu-button"]',
        ].map(
          (s) =>
            `${s} ${getComputedStyle(document.querySelector(s) as Element).transitionProperty}`,
        ),
      );
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reduced = await props();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const full = await props();
    await page.close();
    expect(reduced.filter((p) => !p.endsWith(" none"))).toEqual([]);
    expect(full.filter((p) => p.endsWith(" none"))).toEqual([]);
  });

  it("mobile sheet does not animate", async () => {
    const page = await openStory(browser, SIDEBAR, "light", READY_SIDEBAR, {
      width: 390,
      height: 760,
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator('[data-sidebar="trigger"]').click();
    await settled(page, '[data-mobile="true"][role="dialog"]');
    const reduced = await names(page);
    const full = await motion(page, false);
    await page.close();
    expect(reduced).toContain("sheet-content none");
    expect(reduced.filter((n) => !n.endsWith(" none"))).toEqual([]);
    expect(full.filter((n) => n.endsWith(" none"))).toEqual([]);
  });
});
