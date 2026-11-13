// #2080: "Who can comment" in the Share panel (public and private artifact) and
// the signed-out viewer's comments panel (mock=signed-out), at 1280 and 390, light and dark.
import { mkdirSync } from "node:fs";
import { expect, type Page, type TestInfo, test } from "@playwright/test";

const LANDING = "Cd5fGhJkLm6nPqRs";
const POLL = "Gh9kLmNpQrAsTuVx"; // public
const OUT = process.env.SHOTS_DIR;

const shoot = async (page: Page, info: TestInfo, name: string) => {
  const body = await page.screenshot();
  await info.attach(name, { body, contentType: "image/png" });
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: `${OUT}/${name}.png` });
  }
};

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
    test.describe(`${width}px ${theme}`, () => {
      test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ colorScheme: theme });
        await page.setViewportSize({ width, height: 900 });
      });
      for (const [name, id, n] of [
        ["share-public", POLL, 3],
        ["share-private", LANDING, 2],
      ] as const)
        test(name, async ({ page }, info) => {
          await page.goto(`/a/${id}?panel=open&tab=share`);
          const g = page.getByRole("group", { name: "Who can comment" });
          await expect(g.getByRole("radio")).toHaveCount(n);
          await g.scrollIntoViewIfNeeded();
          await shoot(page, info, `${name}-${width}-${theme}`);
        });
      test("signed-out viewer", async ({ page }, info) => {
        await page.goto(
          `/a/${LANDING}?mock=signed-out&panel=open&tab=comments`,
        );
        const link = page.getByRole("link", { name: "Log in to comment" });
        if (width < 600)
          await page.getByRole("button", { name: /^Comments/ }).click();
        await expect(link).toBeVisible();
        await shoot(page, info, `signed-out-${width}-${theme}`);
      });
    });
