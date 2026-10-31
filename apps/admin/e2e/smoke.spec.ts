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

test("create an install, land on its job, open the install", async ({
  page,
}) => {
  await page.goto("/installs/new");
  await page.getByLabel("Name").fill("e2e-fresh");
  await page.getByLabel("Owner email").fill("owner@example.com");
  await expect(page.getByText("Available.")).toBeVisible();
  await expect(page.getByLabel("Version")).toHaveValue("1.42.0");
  await page.getByRole("button", { name: "Create install" }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9A-Z]{26}$/);
  await expect(page.getByRole("heading", { name: "create job" })).toBeVisible();
  // The dev mock moves the job on by itself: queued, running, then done.
  await expect(page.getByTestId("status")).toHaveText("done", {
    timeout: 15_000,
  });
  await page.getByRole("link", { name: "e2e-fresh" }).click();
  await expect(page.getByRole("heading", { name: "e2e-fresh" })).toBeVisible();
  await expect(page.getByTestId("state")).toHaveText("active");
});

test("mint a token and see its secret once", async ({ page }) => {
  await page.goto("/tokens");
  await page.getByLabel("Label").fill("e2e token");
  await page.getByRole("button", { name: "Mint token" }).click();
  const secret = page.getByTestId("secret");
  await expect(secret).toContainText("shown only once");
  await page.getByRole("button", { name: "I have copied it" }).click();
  await expect(secret).toHaveCount(0);
  await expect(page.getByText("e2e token")).toBeVisible();
});
