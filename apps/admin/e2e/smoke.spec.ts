import { expect, test } from "@playwright/test";

test("signed in: / shows the shell and Installs", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Platform admin").first()).toBeVisible();
  await expect(page.getByText("admin@example.com")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Installs" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Agent tokens" })).toBeVisible();
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
  await page.getByLabel("Slug").fill("e2e-fresh");
  await page.getByLabel("Owner email").fill("owner@example.com");
  await expect(
    page.getByText("e2e-fresh.open-artifacts-staging.app is available."),
  ).toBeVisible();
  await expect(page.getByLabel("Release")).toHaveValue("1.42.0");
  await page.getByRole("button", { name: "Create install" }).click();
  await expect(page).toHaveURL(/\/jobs\/[0-9A-Z]{26}$/);
  await expect(
    page.getByRole("heading", { name: "Creating e2e-fresh" }),
  ).toBeVisible();
  // The dev mock moves the job on by itself: queued, running, then done.
  await expect(page.getByTestId("status")).toHaveText("done", {
    timeout: 15_000,
  });
  await page.getByRole("link", { name: "e2e-fresh" }).click();
  await expect(page.getByRole("heading", { name: "e2e-fresh" })).toBeVisible();
  await expect(page.getByTestId("state")).toHaveText("Active");
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

// The dev mock keeps its state in the page: use in-app links, not page.goto, between steps.
test.describe("lifecycle", () => {
  // Each job takes about 3 s in the dev mock; a few tests run two.
  test.describe.configure({ timeout: 60_000 });
  const LEO = "ileoabcdefg2";
  const ACME = "iacmeabcdef3";
  const BROKEN_JOB = "01JD7Z9W5Q8X3N4M2K1H0G9F8F";
  const jobDone = (page: import("@playwright/test").Page) =>
    expect(page.getByTestId("status")).toHaveText("done", { timeout: 15_000 });

  test("upgrade to another release", async ({ page }) => {
    await page.goto(`/installs/${LEO}`);
    await page.getByRole("button", { name: "Upgrade" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Version").selectOption("1.41.2");
    await dialog.getByRole("button", { name: "Upgrade" }).click();
    await expect(
      page.getByRole("heading", { name: "Upgrading leo" }),
    ).toBeVisible();
    await jobDone(page);
    await page.getByRole("link", { name: "leo" }).first().click();
    await expect(page.getByText("1.41.2").first()).toBeVisible();
  });

  test("pause with a reason", async ({ page }) => {
    await page.goto(`/installs/${ACME}`);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("button", { name: "Pause acme" }),
    ).toBeDisabled();
    await dialog.getByLabel("Reason").fill("Billing hold");
    await dialog.getByRole("button", { name: "Pause acme" }).click();
    await expect(
      page.getByRole("heading", { name: "Pausing acme" }),
    ).toBeVisible();
    await jobDone(page);
    await page.getByRole("link", { name: "acme" }).first().click();
    await expect(page.getByTestId("state")).toHaveText("Paused");
  });

  test("delete needs the slug typed", async ({ page }) => {
    await page.goto(`/installs/${LEO}`);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const go = dialog.getByRole("button", { name: "Delete leo" });
    await expect(go).toBeDisabled();
    await dialog.getByRole("textbox").fill("lea");
    await expect(go).toBeDisabled();
    await dialog.getByRole("textbox").fill("leo");
    await expect(go).toBeEnabled();
    await go.click();
    await expect(
      page.getByRole("heading", { name: "Deleting leo" }),
    ).toBeVisible();
    await jobDone(page);
    await page.getByRole("link", { name: "leo" }).first().click();
    await expect(page.getByTestId("state")).toHaveText("Deleted, restorable");
  });

  test("purge sends a stale sign-in to a fresh one, returning to the install", async ({
    page,
  }) => {
    let start = "";
    await page.route("**/auth/start*", (route) => {
      start = route.request().url();
      return route.fulfill({
        contentType: "text/html",
        body: "<h1>Sign in</h1>",
      });
    });
    await page.goto(`/installs/${LEO}`);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog").getByRole("textbox").fill("leo");
    await page.getByRole("button", { name: "Delete leo" }).click();
    await jobDone(page);
    await page.getByRole("link", { name: "leo" }).first().click();
    await page.getByRole("button", { name: "Purge" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Sign in again to continue.");
    await dialog.getByRole("button", { name: "Sign in again" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/auth/start\\?reauth=1&return=%2Finstalls%2F${LEO}$`),
    );
    expect(start).toContain("reauth=1");
  });

  test("purge after a fresh sign-in needs the slug typed", async ({ page }) => {
    await page.goto("/installs?mock=fresh");
    await page.getByRole("link", { name: "leo" }).first().click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("dialog").getByRole("textbox").fill("leo");
    await page.getByRole("button", { name: "Delete leo" }).click();
    await jobDone(page);
    await page.getByRole("link", { name: "leo" }).first().click();
    await page.getByRole("button", { name: "Purge" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).not.toContainText("Sign in again");
    const go = dialog.getByRole("button", { name: "Purge" });
    await expect(go).toBeDisabled();
    await dialog.getByRole("textbox").fill("leo");
    await go.click();
    await expect(page).toHaveURL(/\/jobs\/[0-9A-Z]{26}$/);
    await expect(
      page.getByRole("heading", { name: "Deleting for good leo" }),
    ).toBeVisible();
    await jobDone(page);
    await page.getByRole("link", { name: "leo" }).first().click();
    await expect(page.getByTestId("state")).toHaveText("Deleted");
  });

  test("retry a failed create from its job", async ({ page }) => {
    await page.goto(`/jobs/${BROKEN_JOB}`);
    await expect(page.getByTestId("job-error")).toContainText("Create stopped");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page).not.toHaveURL(new RegExp(`${BROKEN_JOB}$`));
    await expect(page.getByRole("heading", { name: /broken/ })).toBeVisible();
    await jobDone(page);
    await page.getByRole("link", { name: "broken" }).first().click();
    await expect(page.getByTestId("state")).toHaveText("Active");
  });
});
