// #3032: a whole-page comment you just posted is at the top of the list and in
// view, not below the older notes.
import { expect, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page

test.use({
  launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks"] },
});

for (const [w, h] of [
  [1280, 800],
  [390, 844],
] as const)
  test(`${w}px: a posted page note is first and in view`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/a/${ID}?mock=agents`);
    await page.getByRole("button", { name: /^Comments/ }).click();
    const box = page.getByRole("textbox", {
      name: "Comment on the whole page",
    });
    await expect(box).toBeVisible();
    // Older notes are there to land below: several, as in the report.
    const threads = page.locator("[data-thread]");
    expect(await threads.count()).toBeGreaterThan(2);
    const body = `New page note ${w}`;
    await box.fill(body);
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    // It is the first thread, and the reader is looking at it.
    await expect(threads.first()).toContainText(body);
    await expect(threads.first()).toBeInViewport();
  });
