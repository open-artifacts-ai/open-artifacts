// #2486: the comments panel at in-between widths. Shots only when
// NARROW_SHOTS_DIR is set.
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.NARROW_SHOTS_DIR;
const TAG = process.env.NARROW_SHOTS_TAG ?? "after";
const WIDTHS = (process.env.NARROW_SHOTS_WIDTHS ?? "390,600,640,760,960,1280")
  .split(",")
  .map(Number);

test.skip(!OUT, "shots only");

for (const w of WIDTHS) {
  for (const theme of ["light", "dark"] as const) {
    test(`${w} ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: w, height: w < 600 ? 844 : 800 });
      await page.goto(`/a/${ID}?mock=asks`);
      await expect(page.locator("[data-asks-for-you]")).toBeVisible();
      mkdirSync(OUT as string, { recursive: true });
      await page.screenshot({ path: `${OUT}/${TAG}-${w}-${theme}-closed.png` });
      await page.getByRole("button", { name: /^Comments/ }).click();
      await expect(page.locator("[data-ask]").first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: `${OUT}/${TAG}-${w}-${theme}-open.png` });
    });
  }
}
