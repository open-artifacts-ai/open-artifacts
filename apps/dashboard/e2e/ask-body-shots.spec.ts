// #2344: an ask card shows the comment body (the steps) above the question.
// Shots only when ASK_BODY_SHOTS_DIR is set.
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.ASK_BODY_SHOTS_DIR;

for (const w of [1280, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`${w} ${theme}: ask card shows the steps body`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: w, height: w < 600 ? 844 : 800 });
      await page.goto(`/a/${ID}?mock=asks`);
      await page.getByRole("button", { name: /^Comments/ }).click();
      const card = page.locator("[data-ask]", {
        hasText: "Which layout do we ship?",
      });
      const body = card.locator("[data-ask-body]");
      await expect(body).toContainText("Resize to 390 px wide");
      await expect(card.getByText("Which layout do we ship?")).toBeVisible();
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        await card.screenshot({ path: `${OUT}/${w}-${theme}-ask-body.png` });
      }
    });
  }
}
