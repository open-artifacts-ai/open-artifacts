// Shots for contributor PR #1662 (phone Comments tap target in full screen).
// Runs on main (before) and with the PR's diff (after); outlines show targets.
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs";
const OUTLINE = `.oa-fscomments::before{outline:2px solid #e11d48;outline-offset:-1px}
.oa-fscomments{outline:1px dashed #e11d48}
.oa-fsx{outline:1px dashed #2563eb}.oa-fsx::before{outline:2px solid #2563eb;outline-offset:-1px}`;
const settle = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((x) => x.playState !== "running"),
  );

for (const scheme of ["light", "dark"] as const)
  test.describe(`${scheme} 390`, () => {
    test.use({
      colorScheme: scheme,
      hasTouch: true,
      viewport: { width: 390, height: 800 },
    });
    test("full-screen toolbar", async ({ page }, info) => {
      await page.goto(`/a/${ID}/full`);
      await expect(page.locator(".oa-fscomments")).toBeVisible();
      await settle(page);
      const clip = { x: 0, y: 0, width: 390, height: 140 };
      await page.screenshot({
        path: info.outputPath(`toolbar-${scheme}.png`),
        clip,
      });
      await page.addStyleTag({ content: OUTLINE });
      await page.screenshot({
        path: info.outputPath(`toolbar-targets-${scheme}.png`),
        clip,
      });
      await page.screenshot({ path: info.outputPath(`page-${scheme}.png`) });
    });
  });
