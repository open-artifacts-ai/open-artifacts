// #2306: an @name that is no agent on the page says so (mock=agents lists no "Zed").
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.MENTION_SHOTS_DIR;

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
    test(`unmatched mention line at ${width}px ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/a/${ID}?mock=agents`);
      await page.getByRole("button", { name: /^Comments/ }).click();
      const box = page
        .getByRole("textbox", { name: "Comment on the whole page" })
        .first();
      await box.click();
      await box.fill("@OA Manager hello, and @Zed Ops what do you think?");
      const line = page.getByRole("status").filter({ hasText: "@Zed Ops" });
      await expect(line).toHaveText(
        "@Zed Ops isn't an agent on this page, so they won't be notified.",
      );
      await expect(page.getByText("@OA Manager isn't")).toHaveCount(0);
      await page.waitForTimeout(300);
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        await page.screenshot({
          path: `${OUT}/unmatched-${width}-${theme}.png`,
        });
      }
    });
