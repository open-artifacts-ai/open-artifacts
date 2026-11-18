import { expect, test } from "@playwright/test";

const theme = "light";
test("enabled controls show a pointer and remain actionable", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
  const nav = page.getByRole("navigation", { name: "Primary" });
  await expect(
    nav.getByRole("link", { name: "Library", exact: true }),
  ).toHaveCSS("cursor", "pointer");
  await expect(
    page.getByRole("searchbox", { name: "Search artifacts" }),
  ).toHaveCSS("cursor", "text");

  const toggle = page.getByRole("button", { name: "Toggle navigation" });
  await expect(toggle).toHaveCSS("cursor", "pointer");
  await toggle.click();
  await expect(page.locator("[data-side][data-state]").first()).toHaveAttribute(
    "data-state",
    "collapsed",
  );

  const upload = page.getByRole("button", {
    name: "Upload files",
    exact: true,
  });
  await expect(upload).toHaveCSS("cursor", "pointer");
  const chooser = page.waitForEvent("filechooser");
  await upload.click();
  expect((await chooser).isMultiple()).toBe(true);

  const mine = page.getByRole("tab", { name: "Mine", exact: true });
  await expect(mine).toHaveCSS("cursor", "pointer");
  await mine.click();
  await expect(page).toHaveURL(/\/mine$/);
  await expect(mine).toHaveAttribute("aria-selected", "true");

  const account = page.getByRole("button", { name: "Account menu" });
  await expect(account).toHaveCSS("cursor", "pointer");
  await account.click();
  const signOut = page.getByRole("menuitem", { name: "Log out" });
  await expect(signOut).toBeVisible();
  await expect(signOut).toHaveCSS("cursor", "pointer");
  await page.keyboard.press("Escape");

  const agent = page.getByRole("combobox", { name: "Agent", exact: true });
  await expect(agent).toHaveCSS("cursor", "pointer");
  await agent.click();
  const option = page.getByRole("option").first();
  await expect(option).toBeVisible();
  await expect(option).toHaveCSS("cursor", "pointer");
  await option.click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
});
