// #2191: from 768px the dashboard's <main> scrolls, so the document must never
// grow past the window. Absolute .sr-only text deep in a long page (the plan
// comparison's "Included" cells) used to escape <main> and stretch it.
import { expect, test } from "@playwright/test";

for (const path of [
  "/settings/plan?hosted=plan-team",
  "/",
  "/settings/members",
])
  test(`no document scroll at 1280x420 on ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.goto(path);
    await page.locator("#oa-main").waitFor();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (document.scrollingElement?.scrollHeight ?? 0) - window.innerHeight,
        ),
      )
      .toBeLessThanOrEqual(0);
  });
