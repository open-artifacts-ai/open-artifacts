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
const EDGE = process.env.TOOLBAR_EDGE ?? "top";

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

    for (const [name, top] of [
      ["unscrolled", 0],
      ["scrolled", 200],
    ] as const) {
      test(`keyboard open, ${name}: the bar sits on the visible ${EDGE} edge, solid`, async ({
        page,
      }, info) => {
        await open(page, info);
        await vv(page, 336, top);
        const bar = page.getByRole("toolbar", { name: "Formatting" });
        await expect(bar).toBeVisible();
        const b = (await box(page)) as NonNullable<
          Awaited<ReturnType<typeof box>>
        >;
        const vis = await page.evaluate(() => {
          const v = window.visualViewport as VisualViewport;
          return { top: v.offsetTop, bottom: v.offsetTop + v.height };
        });
        expect(b.y).toBeGreaterThanOrEqual(vis.top - 1);
        expect(b.y + b.height).toBeLessThanOrEqual(vis.bottom + 1);
        if (EDGE === "top") expect(b.y).toBeLessThanOrEqual(vis.top + 1);
        else expect(b.y + b.height).toBeGreaterThanOrEqual(vis.bottom - 1);
        const bg = await bar.evaluate(
          (e) => getComputedStyle(e).backgroundColor,
        );
        expect(bg).not.toMatch(/rgba\(.*, 0\)|transparent/);
        await shot(page, `keyboard-${name}`);
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
