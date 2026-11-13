// #2418: the comments column at 560, 720 and 900, light and dark, in a 1600px window.
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.WIDER_SHOTS_DIR;

for (const theme of ["light", "dark"] as const) {
  for (const w of [560, 720, 900]) {
    test(`comments column ${w} ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.addInitScript(
        (v) => localStorage.setItem("oa.comments.width", v),
        String(w),
      );
      await page.goto(`/a/${ID}?mock=agents`);
      await page.getByRole("button", { name: /^Comments/ }).click();
      await expect(page.getByRole("separator")).toBeVisible();
      const col = page.getByRole("complementary", { name: "Comments" });
      expect(await col.evaluate((e) => e.getBoundingClientRect().width)).toBe(
        w,
      );
      // The resize line's fade has finished.
      await page.evaluate(() =>
        Promise.all(document.getAnimations().map((a) => a.finished)),
      );
      if (!OUT) return;
      mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: `${OUT}/comments-${w}-${theme}.png` });
    });
  }
}

test("1280 window: End reaches 800, the artifact keeps 480", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/a/${ID}?mock=agents`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  await page.getByRole("separator").focus();
  await page.keyboard.press("End");
  const col = page.getByRole("complementary", { name: "Comments" });
  expect(await col.evaluate((e) => e.getBoundingClientRect().width)).toBe(800);
});
