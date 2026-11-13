// #2348: on touch a link's host follows its label. Shots only when LINK_HOST_SHOTS_DIR is set.
import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.LINK_HOST_SHOTS_DIR;

for (const phone of [false, true]) {
  const w = phone ? 390 : 1280;
  test.describe(`${w}`, () => {
    test.use({ hasTouch: phone, isMobile: phone });
    for (const theme of ["light", "dark"] as const) {
      test(`${theme}: host ${phone ? "shown" : "not shown"}`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.setViewportSize({ width: w, height: phone ? 844 : 800 });
        await page.goto(`/a/${ID}?mock=markdown`);
        await page.getByRole("button", { name: /^Comments/ }).click();
        const body = page.getByText("the guide", { exact: false }).first();
        await expect(body).toBeVisible();
        const para = page.locator("p", { hasText: "the guide" }).first();
        if (phone) await expect(para).toContainText("the guide (example.com)");
        else await expect(para).not.toContainText("(example.com)");
        if (OUT) {
          mkdirSync(OUT, { recursive: true });
          await para.screenshot({ path: `${OUT}/${w}-${theme}-link-host.png` });
        }
      });
    }
  });
}
