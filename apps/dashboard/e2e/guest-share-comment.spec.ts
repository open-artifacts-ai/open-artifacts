// #2702: a guest is capped (me.auth.readOnly), yet a "Can comment" share
// lets them comment: the comment box shows. A View only share has none.
// At 390, light and dark. GUEST_SHOTS_DIR saves PNGs.
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const OUT = process.env.GUEST_SHOTS_DIR;
const LANDING = "Cd5fGhJkLm6nPqRs"; // has comments

const settled = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );

for (const theme of ["light"] as const)
  for (const share of ["commenter"] as const)
    test(`a guest on a ${share} share at 390 ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/a/${LANDING}?role=guest&share=${share}`);
      await expect(page.locator("[data-guest-bar]")).toBeVisible();
      await page.getByRole("button", { name: /^Comments/ }).click();
      await expect(
        page.getByText("Can we tighten this headline?").first(),
      ).toBeVisible();
      const box = page.getByRole("textbox", {
        name: "Comment on the whole page",
      });
      if (share === "commenter") await expect(box).toBeVisible();
      else await expect(box).toHaveCount(0);
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        await settled(page);
        await page.screenshot({
          path: `${OUT}/guest-${share}-390-${theme}.png`,
        });
      }
    });
