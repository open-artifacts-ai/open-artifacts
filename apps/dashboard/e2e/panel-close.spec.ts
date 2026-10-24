// #184 follow-up (Design on #509): the side panel's close is a ghost icon-sm
// button named "Close panel", centred on the tab row. 1280 and 390, light and dark.
import { expect, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs";

for (const scheme of ["light", "dark"] as const)
  for (const width of [1280, 390])
    test(`panel close ${scheme} ${width}`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/a/${ID}?panel=open&tab=versions`);
      const close = page.getByRole("button", { name: "Close panel" });
      const tab = page.getByRole("tab", { name: "Versions" });
      await expect(close).toBeVisible();
      const [c, t] = await Promise.all([
        close.boundingBox(),
        tab.boundingBox(),
      ]);
      expect(c?.width).toBe(32);
      expect(c?.height).toBe(32);
      // Centred on the tab row, within half a pixel.
      const mid = (b: typeof c) => (b?.y ?? 0) + (b?.height ?? 0) / 2;
      expect(Math.abs(mid(c) - mid(t))).toBeLessThanOrEqual(0.5);
      expect(await close.getAttribute("data-variant")).toBe("ghost");
      await page.screenshot({
        path: info.outputPath(`panel-close-${width}-${scheme}.png`),
        clip: {
          x: Math.max(0, width - 400),
          y: 0,
          width: Math.min(400, width),
          height: 220,
        },
      });
      await close.click();
      await expect(
        page.getByRole("complementary", { name: "Side panel" }),
      ).toHaveCount(0);
    });
