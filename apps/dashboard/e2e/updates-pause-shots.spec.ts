// #2552: Settings › Machines, the owner's "Pause updates" switch. Shots only
// when UPDATES_PAUSE_SHOTS_DIR is set; the assertions always run.
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const OUT = process.env.UPDATES_PAUSE_SHOTS_DIR;

for (const theme of ["light", "dark"] as const) {
  test(`${theme}: Pause updates off, then on`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto("/settings/machines?mock=bus");
    const sw = page.getByRole("switch", { name: "Pause updates" });
    await expect(sw).toHaveAttribute("aria-checked", "false");
    const card = page.locator("section", {
      has: page.getByRole("heading", { name: "Updates" }),
    });
    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      await card.screenshot({ path: `${OUT}/${theme}-off.png` });
    }
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await expect(card).toContainText("Paused. Every machine stays");
    await expect(sw).toBeEnabled();
    if (OUT) {
      await card.screenshot({ path: `${OUT}/${theme}-on.png` });
      await page.screenshot({ path: `${OUT}/${theme}-page-on.png` });
    }
  });
}
