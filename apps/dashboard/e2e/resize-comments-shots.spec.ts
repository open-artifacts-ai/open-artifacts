// #1986: the resizable comments column at 1280 and 960, light and dark.
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.RESIZE_SHOTS_DIR;

async function open(page: Page, w: number, theme: string, stored?: string) {
  await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
  await page.setViewportSize({ width: w, height: 800 });
  if (stored)
    await page.addInitScript(
      (v) => localStorage.setItem("oa.comments.width", v),
      stored,
    );
  await page.goto(`/a/${ID}?mock=agents`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  await expect(page.getByRole("separator")).toBeVisible();
}
async function shot(page: Page, name: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  // Past the line's 0.12s fade.
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}
const colW = (page: Page) =>
  page
    .getByRole("complementary", { name: "Comments" })
    .evaluate((e) => e.getBoundingClientRect().width);

for (const theme of ["light", "dark"]) {
  test(`1280 ${theme}: default, min, max`, async ({ page }) => {
    await open(page, 1280, theme);
    expect(await colW(page)).toBe(352);
    await shot(page, `1280-${theme}-default`);
    const h = page.getByRole("separator");
    await h.focus();
    await page.keyboard.press("Home");
    expect(await colW(page)).toBe(300);
    await shot(page, `1280-${theme}-min-focus`);
    await page.keyboard.press("End");
    expect(await colW(page)).toBe(560);
    await shot(page, `1280-${theme}-max`);
    await page.keyboard.press("Enter");
    await page.mouse.move(2, 2);
    await h.hover();
    await shot(page, `1280-${theme}-hover`);
  });
  test(`960 ${theme}: max`, async ({ page }) => {
    await open(page, 960, theme, "560");
    expect(await colW(page)).toBe(360);
    await shot(page, `960-${theme}-max`);
  });
  test(`drag ${theme}`, async ({ page }) => {
    await open(page, 1280, theme);
    const b = (await page.getByRole("separator").boundingBox())!;
    await page.mouse.move(b.x + 5, 400);
    await page.mouse.down();
    await page.mouse.move(b.x - 95, 400);
    await shot(page, `1280-${theme}-dragging`);
    await page.mouse.up();
    expect(await colW(page)).toBe(452);
    await page.reload();
    await page.getByRole("button", { name: /^Comments/ }).click();
    expect(await colW(page)).toBe(452);
  });
}
test("800 and 390: unchanged, no handle", async ({ page }) => {
  for (const w of [800, 390]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.goto(`/a/${ID}?mock=agents`);
    await expect(page.getByRole("separator")).toHaveCount(0);
  }
});
