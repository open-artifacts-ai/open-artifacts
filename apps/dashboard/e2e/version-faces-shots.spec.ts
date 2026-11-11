// #2118 item 11: faces in the version list (mock=agents): the newest four rows
// are an unlinked agent, a linked agent, an outsider's view, and a person.
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const OUT = process.env.VERSION_SHOTS_DIR;
const ID = "Ef7hJkLmNp8qRsTv"; // Parser script: v25..v22 are unlinked, linked, outsider, person

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
    test(`version faces at ${width}px ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/a/${ID}?mock=agents&panel=open&tab=versions`);
      const list = page.getByRole("list", { name: "Versions" });
      await expect(list).toBeVisible();
      const first = list.locator("li").first();
      await expect(first.locator("[data-linked='false']")).toBeVisible();
      await page.addStyleTag({
        content: "ol li:nth-child(n+5){display:none}",
      });
      await page.waitForTimeout(300);
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        await (width === 1280 ? list : page).screenshot({
          path: `${OUT}/versions-${width}-${theme}.png`,
        });
      }
    });
