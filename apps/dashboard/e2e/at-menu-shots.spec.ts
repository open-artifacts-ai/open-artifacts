// The @ menu: an online agent, an away agent, look-alike names on two machines
// and the selected row, at 1280 and 390, light and dark. AT_MENU_SHOTS_DIR saves the PNGs.
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.AT_MENU_SHOTS_DIR;

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
    test(`@ menu at ${width}px ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/a/${ID}`);
      await page.getByRole("button", { name: /^Comments/ }).click();
      const box = page.getByRole("textbox", { name: /Comment on/ }).first();
      await box.click();
      await box.pressSequentially("@");
      const menu = page.getByRole("listbox", { name: "Agents on this page" });
      await expect(menu).toBeVisible();
      await page.keyboard.press("ArrowDown");
      const rows = menu.getByRole("option");
      await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
      // Online first, away after; the look-alike pair carries its machine.
      await expect(rows.nth(0)).toContainText("online");
      await expect(menu).toContainText("OA Manager-2");
      await expect(menu).toContainText("online · Sam's");
      await expect(menu).toContainText("away 19h · workstation");
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        await page.screenshot({ path: `${OUT}/at-menu-${width}-${theme}.png` });
      }
    });
