// #2511: the ask card's withdrawn states. Shots only when ASK_WITHDRAWN_SHOTS_DIR is set.
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.ASK_WITHDRAWN_SHOTS_DIR;
const shot = async (
  loc: { screenshot: (o: { path: string }) => Promise<unknown> },
  name: string,
) => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  await loc.screenshot({ path: `${OUT}/${name}.png` });
};

for (const w of [1280, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`${w} ${theme}: the withdrawn card states`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: w, height: w < 600 ? 844 : 900 });
      await page.goto(`/a/${ID}?mock=withdrawn`);
      await page.getByRole("button", { name: /^Comments/ }).click();
      const pane =
        w <= 600
          ? page.getByRole("dialog")
          : page.locator("aside").filter({ has: page.getByRole("tab") });
      const gone = page.locator("[data-ask-withdrawn]");
      await expect(gone).toHaveCount(3);
      const lines = page.locator("[data-ask-withdrawn-line]");
      await expect(lines.filter({ hasText: /^Withdrawn$/ })).toHaveCount(1);
      await expect(
        lines.filter({ hasText: "Withdrawn. Replaced by the card below." }),
      ).toHaveCount(1);
      const link = page.getByRole("link", { name: "Launch post" });
      await expect(link).toHaveAttribute("href", /\/a\/Ab3dEfGhJk4mNpQr$/);
      await expect(
        lines.filter({
          hasText: "Withdrawn. Replaced by a card on Launch post.",
        }),
      ).toHaveCount(1);
      // No buttons on a withdrawn card.
      await expect(gone.first().getByRole("button")).toHaveCount(0);
      // The open card still has its options.
      await expect(
        page.locator("[data-ask]:not([data-ask-withdrawn])").first(),
      ).toBeVisible();
      await shot(pane.first(), `${w}-${theme}-withdrawn`);
    });
  }
}
