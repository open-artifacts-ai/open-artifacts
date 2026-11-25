// #2741: the Share panel's notice for the sharer's own pause (sender_paused,
// with and without pausedUntil). Shots only when SHARE_PAUSED_SHOTS_DIR is set;
// the assertions always run.
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const OUT = process.env.SHARE_PAUSED_SHOTS_DIR;
const ID = "Cd5fGhJkLm6nPqRs"; // Landing page

const cases = [
  {
    name: "until-18-nov",
    query: "&notEmailed=sender_paused&pausedUntil=2026-11-18T09:00:00.000Z",
    line: /are paused until 18 Nov, because some earlier ones bounced or were reported\./,
  },
  {
    name: "for-now",
    query: "&notEmailed=sender_paused",
    line: /are paused for now, because some earlier ones bounced or were reported\./,
  },
] as const;

for (const theme of ["light", "dark"] as const) {
  for (const c of cases) {
    test(`${theme}: ${c.name}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: 1100, height: 900 });
      await page.goto(`/a/${ID}?panel=open&tab=share${c.query}`);
      await page.getByLabel("Email").fill("sam@partner.org");
      await page.getByRole("button", { name: "Add" }).click();
      const notice = page
        .getByText(/Shared with sam@partner\.org/)
        .locator("xpath=..");
      await expect(notice).toContainText("We didn't email them.");
      await expect(notice).toContainText(c.line);
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        await page
          .locator("[data-share-sent]")
          .first()
          .locator("xpath=../..")
          .screenshot({ path: `${OUT}/${theme}-${c.name}.png` });
      }
    });
  }
}
