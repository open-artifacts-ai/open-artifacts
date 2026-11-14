// #2276: on a phone (640px and under) the doc toolbar sits at the bottom of the
// screen, above the on-screen keyboard. The keyboard is emulated by a fake
// visualViewport the test shrinks (Chromium has no real one).
import type { ChildProcess } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { startRoom, stopRoom } from "./room";

const LANDING = "Cd5fGhJkLm6nPqRs";
const DIR = process.env.SHOTS_DIR;
const KEYBOARD = 300;

let room: ChildProcess | undefined;
test.beforeEach(async ({ page }, info) => {
  room = await startRoom(info, page, ["--fakes"]);
  await page.addInitScript(() => {
    const vv = Object.assign(new EventTarget(), {
      height: window.innerHeight,
      offsetTop: 0,
      scale: 1,
    });
    Object.defineProperty(window, "visualViewport", {
      value: vv,
      configurable: true,
    });
    (window as unknown as { __kb: (px: number) => void }).__kb = (px) => {
      vv.height = window.innerHeight - px;
      vv.dispatchEvent(new Event("resize"));
    };
  });
});
test.afterEach(async () => {
  await stopRoom(room);
});

const keyboard = (page: Page, px: number) =>
  page.evaluate(
    (n) => (window as unknown as { __kb: (n: number) => void }).__kb(n),
    px,
  );
const shot = async (page: Page, name: string) => {
  await page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );
  if (DIR) await page.screenshot({ path: `${DIR}/${name}` });
};
const bar = (page: Page) => page.getByRole("toolbar", { name: "Formatting" });
const bottomEdge = async (page: Page) => {
  const box = await bar(page).boundingBox();
  if (!box) throw new Error("no toolbar");
  return box.y + box.height;
};

for (const scheme of ["light", "dark"] as const) {
  test.describe(`phone ${scheme}`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 390, height: 800 } });

    test("the toolbar is at the bottom, then above the keyboard", async ({
      page,
    }) => {
      await page.goto(`/a/${LANDING}?mock=doc`);
      await expect(bar(page)).toBeVisible();
      await expect(page.locator(".ProseMirror")).toBeVisible();
      // At the bottom of the screen, below the text.
      expect(await bottomEdge(page)).toBeCloseTo(800, 0);
      const text = await page.locator(".ProseMirror").boundingBox();
      const top = (await bar(page).boundingBox())?.y ?? 0;
      expect(top).toBeGreaterThan((text?.y ?? 0) + 100);
      await shot(page, `doc-phone-toolbar-${scheme}-390.png`);

      // The keyboard opens: the bar rides on top of it.
      await keyboard(page, KEYBOARD);
      await expect.poll(() => bottomEdge(page)).toBeCloseTo(800 - KEYBOARD, 0);
      await shot(page, `doc-phone-toolbar-keyboard-${scheme}-390.png`);

      // And comes back down when it closes.
      await keyboard(page, 0);
      await expect.poll(() => bottomEdge(page)).toBeCloseTo(800, 0);
    });

    test("a fade marks the cut right edge until the bar is scrolled to the end", async ({
      page,
    }) => {
      await page.goto(`/a/${LANDING}?mock=doc`);
      await expect(bar(page)).toBeVisible();
      const fade = page.locator(".oa-doc-fade");
      const opacity = () =>
        fade.evaluate((el) => Number(getComputedStyle(el).opacity));
      // At 390 the last buttons are cut off: the fade shows.
      await expect(bar(page)).toHaveAttribute("data-more", "");
      await expect.poll(opacity).toBe(1);
      // It sits at the visible right edge of the bar.
      const fb = await fade.boundingBox();
      const bb = await bar(page).boundingBox();
      expect((fb?.x ?? 0) + (fb?.width ?? 0)).toBeCloseTo(
        (bb?.x ?? 0) + (bb?.width ?? 0),
        0,
      );
      // Scrolled to the end: the code-block button shows and the fade is gone.
      await bar(page).evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      await expect(bar(page)).not.toHaveAttribute("data-more");
      await expect.poll(opacity).toBe(0);
      await shot(page, `doc-phone-toolbar-end-${scheme}-390.png`);
      // And back: scrolled left, it returns.
      await bar(page).evaluate((el) => {
        el.scrollLeft = 0;
      });
      await expect(bar(page)).toHaveAttribute("data-more", "");
    });

    test("the last line can scroll clear of the bar", async ({ page }) => {
      await page.goto(`/a/${LANDING}?mock=doc`);
      await expect(bar(page)).toBeVisible();
      const scroll = page.locator(".oa-doc-scroll");
      await scroll.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      const last = await page
        .locator(".ProseMirror > :last-child")
        .boundingBox();
      const top = (await bar(page).boundingBox())?.y ?? 0;
      if (!last) throw new Error("no last block");
      expect(last.y + last.height).toBeLessThanOrEqual(top + 1);
    });
  });
}

test.describe("wider than a phone", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("the toolbar stays on top, with no fade", async ({ page }) => {
    await page.goto(`/a/${LANDING}?mock=doc`);
    await expect(bar(page)).toBeVisible();
    await expect(bar(page)).not.toHaveAttribute("data-more");
    await expect(page.locator(".oa-doc-fade")).toBeHidden();
    expect((await bar(page).boundingBox())?.y).toBeLessThan(200);
  });
});
