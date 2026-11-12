// #1890: a mentioned agent's face on the comments panel (mock=agents): a linked
// and an unlinked @mention with their delivery lines, and an ask to two agents.
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.MENTION_SHOTS_DIR;

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
    test(`mention faces at ${width}px ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/a/${ID}?mock=agents`);
      await page.getByRole("button", { name: /^Comments/ }).click();
      // The long thread holds the mentions and the ask; mock=agents has other threads (#2174).
      await page
        .locator("li[data-thread]")
        .filter({ hasText: "Can the pricing section be shorter?" })
        .getByRole("button", { name: /^Show \d+ earlier repl/ })
        .click();
      const mention = page.locator("[data-mention-chip]").first();
      await expect(mention).toBeVisible();
      await expect(page.locator("[data-ask-to]")).toBeVisible();
      await expect(
        page.locator("[data-ask-to] [data-linked='true']"),
      ).toBeVisible();
      await page.waitForTimeout(300);
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        const file = `${OUT}/mentions-${width}-${theme}.png`;
        if (width === 1280) {
          await page
            .locator("[data-thread]")
            .first()
            .screenshot({ path: file });
        } else {
          // The phone sheet scrolls: show the mention, then the ask.
          await mention.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: `${OUT}/mentions-${width}-${theme}.png`,
          });
          await page.locator("[data-ask-to]").scrollIntoViewIfNeeded();
          await page.waitForTimeout(200);
          await page.screenshot({ path: `${OUT}/ask-${width}-${theme}.png` });
        }
      }
    });
