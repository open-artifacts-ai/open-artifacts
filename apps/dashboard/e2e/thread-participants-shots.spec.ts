// #2174: the participants group at the top of a thread (mock=agents), closed,
// open, after a removal, and the signed-out view. PARTICIPANTS_SHOTS_DIR picks where the PNGs go.
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.PARTICIPANTS_SHOTS_DIR;

async function openComments(page: Page, mock: string, w: number) {
  await page.goto(
    `/a/${ID}?mock=${mock}${w < 600 ? "" : "&panel=open&tab=comments"}`,
  );
  if (w < 600) await page.getByRole("button", { name: /^Comments/ }).click();
}

for (const w of [1280, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`participants ${w} ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: w, height: w < 600 ? 844 : 900 });
      if (OUT) mkdirSync(OUT, { recursive: true });
      const shot = async (name: string) => {
        if (OUT)
          await page.screenshot({ path: `${OUT}/${name}-${w}-${theme}.png` });
      };
      await openComments(page, "agents", w);
      const card = page
        .locator("li[data-thread]")
        .filter({ hasText: "Can the pricing section be shorter?" });
      const trig = card.locator("[data-participants-trigger]");
      await expect(trig).toBeVisible();
      await shot("1-closed");

      if (w >= 600) await trig.hover();
      else await trig.tap();
      const list = card.locator("[data-participants-list]");
      await expect(list).toBeVisible();
      // The list floats: the thread does not grow.
      await shot("2-open");

      await list
        .getByRole("button", {
          name: "Stop notifying OA Product in this thread",
        })
        .click();
      await expect(
        list.getByText(/Remove OA Product from this thread\?/),
      ).toBeVisible();
      await list.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(list.locator("[data-off]")).toContainText("Not notified");
      await expect(
        list.getByText(/won't get replies in this thread/),
      ).toBeVisible();
      await shot("3-removed");

      await page.goto(
        `/a/${ID}?mock=signed-out${w < 600 ? "" : "&panel=open&tab=comments"}`,
      );
      if (w < 600)
        await page.getByRole("button", { name: /^Comments/ }).click();
      const g = page.locator("[data-participants-trigger]").first();
      await expect(g).toBeVisible();
      if (w >= 600) await g.hover();
      else await g.tap();
      await expect(
        page.locator("[data-participants-list]").first(),
      ).toBeVisible();
      await expect(page.locator("[data-participant-agent]")).toHaveCount(0);
      await shot("4-guest");
    });
  }
