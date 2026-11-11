// #2118 item 11: agent faces in the version list (mock=agents).
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.VERSION_SHOTS_DIR;

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
    test(`version faces at ${width}px ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/a/${ID}?mock=agents&panel=open&tab=versions`);
      const list = page.getByRole("list", { name: "Versions" });
      await expect(list).toBeVisible();
      await expect(
        list.locator("[data-avatar='agent'][data-linked='true']"),
      ).toHaveCount(1);
      await page.waitForTimeout(300);
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        await (width === 1280 ? list : page).screenshot({
          path: `${OUT}/versions-${width}-${theme}.png`,
        });
      }
    });
