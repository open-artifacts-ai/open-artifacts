import { expect, test } from "@playwright/test";

test("signed in: / shows the shell and Installs", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Open Artifacts Admin").first()).toBeVisible();
  await expect(page.getByText("admin@example.com")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Installs" })).toBeVisible();
});

test("401 on /api/v1/me sends / to sign-in", async ({ page }) => {
  await page.goto("/installs?mock=unauth");
  await expect(page).toHaveURL(
    /\/sign-in\?return=%2Finstalls%3Fmock%3Dunauth$/,
  );
  await expect(
    page.getByRole("link", { name: "Sign in with Google" }),
  ).toBeVisible();
});

test("/sign-in renders its error state", async ({ page }) => {
  await page.goto("/sign-in?error=expired");
  await expect(page.getByRole("alert")).toContainText("took too long");
});
