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

for (const w of [1280]) {
  for (const theme of ["light"] as const) {
    test(`${w} ${theme}: the withdrawn card states`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      // Tall enough for every card: the shot shows the whole column.
      await page.setViewportSize({ width: w, height: w < 600 ? 2600 : 2000 });
      await page.goto(`/a/${ID}?mock=withdrawn`);
      await page.getByRole("button", { name: /^Comments/ }).click();
      const pane =
        w <= 600
          ? page.getByRole("dialog")
          : page.locator("aside").filter({ has: page.getByRole("tab") });
      const gone = page.locator("[data-ask-withdrawn]");
      await expect(gone).toHaveCount(4);
      const lines = page.locator("[data-ask-withdrawn-line]");
      await expect(lines.filter({ hasText: /^Withdrawn$/ })).toHaveCount(1);
      // Same page: the link names the live card, which sits in the column too.
      const same = lines.filter({ hasText: "Withdrawn. See the new card." });
      await expect(same).toHaveCount(1);
      await expect(
        page.locator("[data-ask]:not([data-ask-withdrawn])").first(),
      ).toBeVisible();
      // Another page, with a title: the title is a link.
      const link = page.getByRole("link", { name: "Launch post" });
      await expect(link).toHaveAttribute("href", /\/a\/Ab3dEfGhJk4mNpQr$/);
      // Another page without access: plain text, no link.
      const noAccess = lines.filter({
        hasText: "Withdrawn. Replaced by a card on another page.",
      });
      await expect(noAccess).toHaveCount(1);
      await expect(noAccess.getByRole("link")).toHaveCount(0);
      // No buttons on a withdrawn card.
      await expect(gone.first().getByRole("button")).toHaveCount(0);
      // The mobile sheet caps its height and scrolls inside: grow it for the shot.
      if (w <= 600)
        await pane.first().evaluate((el) => {
          for (const n of [el, ...el.querySelectorAll<HTMLElement>("*")]) {
            const st = getComputedStyle(n);
            if (/(auto|scroll)/.test(st.overflowY) || n === el) {
              n.style.overflow = "visible";
              n.style.maxHeight = "none";
              n.style.height = "auto";
            }
          }
        });
      await shot(pane.first(), `${w}-${theme}-withdrawn`);
      // "the new card" jumps to and opens that card's thread.
      await same.getByRole("link", { name: "the new card" }).click();
      await expect(
        page.locator("[data-thread][data-active]").filter({
          hasText: "Which pricing table goes on the page?",
        }),
      ).toHaveCount(1);
      await shot(pane.first(), `${w}-${theme}-withdrawn-jump`);
    });
  }
}
