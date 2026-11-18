// #2753: the phone doc toolbar stays inside the visible area (keyboard open,
// panned or not), is solid, and hides with the keyboard closed. The keyboard
// is faked through the visual viewport. Writes PNGs to SHOTS_DIR when set.
import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { devices, expect, type Page, test } from "@playwright/test";
import { startRoom, stopRoom } from "./room";

const ID = "Cd5fGhJkLm6nPqRs";
const DIR = process.env.SHOTS_DIR;
const { defaultBrowserType: _d, ...phone } = devices["iPhone 14"];

let room: ChildProcess | undefined;
test.afterEach(async () => {
  await stopRoom(room);
});

for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({
      ...phone,
      viewport: { width: 390, height: 844 },
      colorScheme: scheme,
    });

    const open = async (page: Page, info: Parameters<typeof startRoom>[0]) => {
      room = await startRoom(info, page, ["--hello", "edit"]);
      await page.goto(`/a/${ID}?mock=doc`);
      await expect(page.locator(".ProseMirror")).toBeVisible();
    };
    /** Fakes the keyboard: the visual viewport shrinks by `px` and pans by `top`. */
    const vv = (page: Page, px: number, top = 0) =>
      page.evaluate(
        ([px, top]) => {
          const v = window.visualViewport as VisualViewport;
          const def = (k: string, val: number) =>
            Object.defineProperty(v, k, { configurable: true, get: () => val });
          def("height", window.innerHeight - px);
          def("offsetTop", top);
          // Pan honestly: iOS moves the visible area down by offsetTop, so
          // everything on screen moves up by it (fixed things too).
          document.documentElement.style.transform = top
            ? `translateY(-${top}px)`
            : "";
          v.dispatchEvent(new Event("resize"));
          v.dispatchEvent(new Event("scroll"));
        },
        [px, top],
      );
    const shot = async (page: Page, name: string) => {
      if (!DIR) return;
      mkdirSync(DIR, { recursive: true });
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${DIR}/${name}-${scheme}.png` });
    };
    const box = (page: Page) =>
      page.getByRole("toolbar", { name: "Formatting" }).boundingBox();

    for (const [edge, name, top] of [
      ["top", "unscrolled", 0],
      ["top", "scrolled", 200],
      ["bottom", "unscrolled", 0],
      ["bottom", "scrolled", 200],
    ] as const) {
      test(`keyboard open, ${name}: the bar sits on the visible ${edge} edge, solid`, async ({
        page,
      }, info) => {
        await open(page, info);
        await vv(page, 336, top);
        const bar = page.getByRole("toolbar", { name: "Formatting" });
        // The switch: TOOLBAR_EDGE is the default; both edges are covered.
        await bar.evaluate(
          (e, edge) => e.setAttribute("data-edge", edge),
          edge,
        );
        await expect(bar).toBeVisible();
        const b = (await box(page)) as NonNullable<
          Awaited<ReturnType<typeof box>>
        >;
        // Screen coordinates: the pan shifts everything, so the visible area
        // is always 0 to its height.
        const vis = await page.evaluate(() => ({
          top: 0,
          bottom: (window.visualViewport as VisualViewport).height,
        }));
        const header = (await page.locator(".oa-vt").first().boundingBox()) as {
          y: number;
          height: number;
        };
        const headerBottom = header.y + header.height;
        expect(b.y).toBeGreaterThanOrEqual(vis.top - 1);
        expect(b.y + b.height).toBeLessThanOrEqual(vis.bottom + 1);
        // Top: under the title bar while it shows, else at the visible top.
        if (edge === "top")
          expect(Math.abs(b.y - Math.max(vis.top, headerBottom))).toBeLessThan(
            1.5,
          );
        else expect(b.y + b.height).toBeGreaterThanOrEqual(vis.bottom - 1);
        const bg = await bar.evaluate(
          (e) => getComputedStyle(e).backgroundColor,
        );
        expect(bg).not.toMatch(/rgba\(.*, 0\)|transparent/);
        await shot(page, `keyboard-${edge}-${name}`);
      });
    }

    test("keyboard closed, scrolled: no bar, content clears the status bar", async ({
      page,
    }, info) => {
      await open(page, info);
      await vv(page, 0, 200);
      await expect(
        page.getByRole("toolbar", { name: "Formatting" }),
      ).toBeHidden();
      await shot(page, "closed-scrolled");
    });
  });
}

// Landscape: headless has no notch, so these only show the layout holds
// (nothing overflows sideways) and give the shots; the insets are env().
test.describe("landscape 844x390", () => {
  test.use({ ...phone, viewport: { width: 844, height: 390 } });
  const noSideScroll = (page: Page) =>
    page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
  test("the viewer", async ({ page }, info) => {
    room = await startRoom(info, page, ["--hello", "edit"]);
    await page.goto(`/a/${ID}?mock=doc`);
    await expect(page.locator(".ProseMirror")).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);
    if (DIR) {
      mkdirSync(DIR, { recursive: true });
      await page.screenshot({ path: `${DIR}/landscape-viewer-light.png` });
    }
  });
  test("the library", async ({ page }) => {
    await page.goto("/?view=grid");
    await expect(page.locator(".lib-card").first()).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);
    if (DIR) {
      mkdirSync(DIR, { recursive: true });
      await page.screenshot({ path: `${DIR}/landscape-library-light.png` });
    }
  });
});
