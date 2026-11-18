// "Reset Google link…" in the Members row menu: the owner resets Bob.
import { expect, test } from "@playwright/test";

test("the owner resets Bob's Google link", async ({ page }) => {
  await page.goto("/settings/members?hosted=1");
  await page.waitForLoadState("networkidle");
  // Google-linked, so he has signed in (the shared fixture, #496).
  const bob = page.locator("li", { hasText: "Bob Builder" });
  await expect(bob).toContainText(/Active .+ ago/);
  await page.getByRole("button", { name: "More for Bob Builder" }).click();
  await page
    .getByRole("menu")
    .getByRole("menuitem", { name: "Reset Google link…" })
    .click();
  const d = page.getByRole("alertdialog");
  await expect(d).toContainText("Reset Google link for Bob Builder?");
  await d.getByRole("button", { name: "Reset link" }).click();
  await expect(
    page.getByText(
      "Google link reset for Bob Builder. They're logged out and link again at their next Google login.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});
