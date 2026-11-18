// #2632 slice 2: Settings, Members, "Copy the setup line". The Setup column's
// states live in test/members-setup.test.tsx.
import { expect, type Page, test } from "@playwright/test";

const URL_ = "/settings/members?mock=members-setup";
const row = (page: Page, who: string) =>
  page.locator("li").filter({ hasText: who });

test("Copy the setup line, for someone not set up", async ({
  page,
  context,
  browserName,
}) => {
  if (browserName === "chromium")
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(URL_);
  await row(page, "Sam Ortiz")
    .getByRole("button", { name: "More for Sam Ortiz" })
    .click();
  await page.getByRole("menuitem", { name: "Copy the setup line" }).click();
  await expect(page.getByText("Copied. Send it to Sam.")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `Set up Open Artifacts for me: follow ${new URL(page.url()).origin}/llms.txt`,
  );
});
