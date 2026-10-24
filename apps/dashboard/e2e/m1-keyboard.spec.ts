// M1 whole-track review: keyboard-only use and quota banner on viewer/diff routes.
import { QUOTA_MESSAGE } from "@oa/shared";
import { expect, type Page, test } from "@playwright/test";

const ring = (page: Page) =>
  page.evaluate(() => {
    const e = document.activeElement as Element;
    const c = getComputedStyle(e);
    return (
      (c.outlineStyle !== "none" && Number.parseFloat(c.outlineWidth) > 0) ||
      c.boxShadow !== "none"
    );
  });

test("account menu button shows a focus ring when tabbed to", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("searchbox", { name: "Search artifacts" }).focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Account menu" }),
  ).toBeFocused();
  expect(await ring(page)).toBe(true);
});

test("library tabs: Tab goes from the tab list to the filters (no empty tab panel stop)", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "All" }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("radio", { name: "All formats" })).toBeFocused();
});

test("restore dialog offers a keyboard-reachable Cancel", async ({ page }) => {
  // Restore sits on the viewed row, so view an older version (#471).
  await page.goto("/a/Cd5fGhJkLm6nPqRs/v/1?panel=open&tab=versions");
  await page.getByRole("button", { name: "Restore" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(
    page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }),
  ).toBeVisible();
});

for (const path of [
  "/a/Cd5fGhJkLm6nPqRs?mock=quota",
  "/a/Cd5fGhJkLm6nPqRs/diff/1/2?mock=quota",
])
  test(`quota banner on ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByText(QUOTA_MESSAGE, { exact: true })).toBeVisible();
  });
