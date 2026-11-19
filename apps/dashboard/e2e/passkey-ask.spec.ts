// #2263, #2864: asks never start a passkey prompt (no passkey on asks for now), on the mock API.
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page

async function open(page: Page, mode: string) {
  await page.goto(`/a/${ID}?mock=asks&passkey=${mode}`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  const card = page
    .locator("[data-ask]")
    .filter({ hasText: "Merge the release PR?" });
  await expect(card).toBeVisible();
  return card;
}

test("an ordinary ask is unchanged", { tag: "@smoke" }, async ({ page }) => {
  let called = false;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {
        get: async () => {
          (window as unknown as { __pk: boolean }).__pk = true;
          return null;
        },
      },
    });
  });
  await open(page, "ok");
  const card = page
    .locator("[data-ask]")
    .filter({ hasText: "Which layout do we ship?" });
  await expect(card.locator("[data-passkey-hint]")).toHaveCount(0);
  await card.locator("[data-option=wide]").click();
  await expect(card.locator("[data-ask-answer]")).toContainText("picked");
  await expect(card.locator("[data-ask-verified]")).toHaveCount(0);
  called = await page.evaluate(
    () => (window as unknown as { __pk?: boolean }).__pk === true,
  );
  expect(called).toBe(false);
});
