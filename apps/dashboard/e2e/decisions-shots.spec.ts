// #2381 S2: the Decisions tab. Shots only when DECISIONS_SHOTS_DIR is set.
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.DECISIONS_SHOTS_DIR;
const shot = async (
  loc: { screenshot: (o: { path: string }) => Promise<unknown> },
  name: string,
) => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await loc.screenshot({ path: `${OUT}/${name}.png` });
};

for (const w of [1280, 760, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`${w} ${theme}: the Decisions tab`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: w, height: w < 600 ? 844 : 900 });
      await page.goto(`/a/${ID}?mock=decisions`);
      await page.getByRole("button", { name: /^Comments/ }).click();
      const pane =
        w <= 600
          ? page.getByRole("dialog")
          : page.locator("aside").filter({ has: page.getByRole("tab") });
      const tab = page.getByRole("tab", { name: /Decisions/ }).first();
      await expect(tab).toBeVisible();
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      const rows = page.locator("[data-decision]");
      await expect(rows).toHaveCount(7);
      // Newest decision first; the composer and "Show resolved" are gone.
      await expect(rows.first()).toContainText("Which pricing table");
      await expect(page.getByText(/^Show resolved/)).toHaveCount(0);
      await expect(page.locator("[data-send-hint]")).toBeHidden();
      await expect(
        page.locator('[data-decision] [data-chip="resolved"]'),
      ).toHaveCount(1);
      await expect(
        page.locator('[data-decision] [data-chip="verified"]'),
      ).toHaveCount(1);
      await expect(
        page.locator('[data-decision] [data-chip="changed"]'),
      ).toHaveCount(1);
      await expect(
        page.locator('[data-decision] a[data-chip="replaced"]'),
      ).toHaveCount(1);
      await shot(pane.first(), `${w}-${theme}-decisions`);
      // A row opens its thread in place, with a back row.
      await rows.nth(1).getByRole("button").first().click();
      await expect(
        page.locator("[data-decision-thread]").first(),
      ).toBeVisible();
      await shot(pane.first(), `${w}-${theme}-decision-open`);
      await page
        .locator("[data-decision-thread]")
        .getByRole("button", { name: "Decisions" })
        .click();
      await expect(rows).toHaveCount(7);
    });

    test(`${w} ${theme}: no decisions yet`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: w, height: w < 600 ? 844 : 900 });
      await page.goto(`/a/${ID}?mock=asks`);
      await page.getByRole("button", { name: /^Comments/ }).click();
      const tab = page.getByRole("tab", { name: /Decisions/ }).first();
      await tab.click();
      await expect(page.getByText("No decisions yet")).toBeVisible();
      await shot(
        w <= 600
          ? page.getByRole("dialog")
          : page
              .locator("aside")
              .filter({ has: page.getByRole("tab") })
              .first(),
        `${w}-${theme}-decisions-empty`,
      );
    });
  }
}
