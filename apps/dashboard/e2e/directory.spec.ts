// Hosted P4 Tasks 17 and 18: /settings/directory, the keyboard path through
// Sync now and the restricted-group picker. Every state and dialog lives in
// test/directory.test.tsx and test/directory-confirm.test.tsx.
import { expect, test } from "@playwright/test";

test("keyboard: Sync now, then add a restricted group without a mouse", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings/directory?hosted=1");
  await page.waitForLoadState("networkidle");
  await page.getByRole("status", { name: "Sync status" }).waitFor();
  const syncNow = page.getByRole("button", { name: "Sync now" });
  await syncNow.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status", { name: "Sync status" }).getByRole("heading"),
  ).toHaveText("Syncing…");
  const box = page.getByRole("combobox", { name: "Add a restricted group" });
  await box.focus();
  await page.keyboard.type("sa");
  await page.getByRole("option", { name: /sales@example.com/ }).waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("row", { name: /sales@example.com/ }),
  ).toBeVisible();
});
