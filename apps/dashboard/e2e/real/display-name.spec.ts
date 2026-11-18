import { expect, freshEmail, loginAs, test, uniq } from "./fixtures";

const TITLE = "What do you like to be called?";

test("a new user names themselves in the dialog, and Profile shows it", {
  tag: "@smoke",
}, async ({ page }) => {
  // Dev login names the user after the email's local part: not a real name.
  await loginAs(page, freshEmail("dn"), "member", { named: false });
  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: TITLE });
  await expect(dialog).toBeVisible();
  const name = `Ada ${uniq()}`;
  await dialog.getByLabel("Your name").fill(`  ${name}  `);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();

  await page.goto("/settings/profile");
  await expect(page.getByLabel("Display name")).toHaveValue(name);
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();

  // Saved on the server: a fresh load doesn't ask again.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: TITLE })).toHaveCount(0);
});
