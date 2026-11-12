// #2229: delivery as marks (mock=agents): the chip's mark delivered and held with its one sentence,
// the header faces for a reply that told four agents and for two, and the hover details.
// DELIVERY_MARKS_SHOTS_DIR picks where the PNGs go.
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.DELIVERY_MARKS_SHOTS_DIR;

async function open(page: Page, text: string) {
  await page.goto(`/a/${ID}?mock=agents`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  await page
    .locator("li[data-thread]")
    .filter({ hasText: text })
    .getByRole("button", { name: /^Show (in page|pin)/ })
    .click();
}

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
    test(`delivery marks at ${width}px ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: 900 });
      if (OUT) mkdirSync(OUT, { recursive: true });
      const shot = async (name: string) => {
        await page.waitForTimeout(200);
        if (OUT)
          await page.screenshot({
            path: `${OUT}/${name}-${width}-${theme}.png`,
          });
      };

      // Mentions: one delivered, one held with its sentence, then the hover.
      await open(page, "Can the pricing section be shorter?");
      const thread = page.locator("li[data-thread]").filter({
        hasText: "Can the pricing section be shorter?",
      });
      const fold = thread.getByRole("button", {
        name: /Show \d+ earlier replies/,
      });
      if (await fold.count()) await fold.first().click();
      const delivered = thread.locator(
        '[data-mention-chip][data-delivery="delivered"]',
      );
      const held = thread.locator(
        '[data-mention-chip][data-delivery="queued"]',
      );
      await expect(delivered).toBeVisible();
      await expect(held).toBeVisible();
      await expect(delivered.locator('[data-mark="ok"]')).toBeVisible();
      await expect(held.locator('[data-mark="wait"]')).toBeVisible();
      await expect(
        thread.getByText("Claude Code is offline. Held until it's back."),
      ).toHaveCount(1);
      const removed = thread.locator(
        '[data-mention-chip][data-delivery="withdrawn"]',
      );
      await expect(removed.locator('[data-mark="removed"]')).toBeVisible();
      await delivered.scrollIntoViewIfNeeded();
      await shot("1-mentions");
      await removed.hover();
      await expect(page.getByRole("tooltip")).toContainText(
        "removed before delivery",
      );
      await shot("1b-removed-hover");
      await delivered.hover();
      await expect(page.getByRole("tooltip")).toContainText("delivered");
      await shot("2-chip-hover");
      await page.mouse.move(0, 0);

      // A reply that told six agents: three faces, +3, a clock with 5 of 6... as seeded.
      const six = thread
        .locator("[data-delivery-faces]")
        .filter({ has: page.locator("[data-more]") })
        .first();
      await expect(six.locator("[data-avatar]")).toHaveCount(3);
      await expect(six.locator("[data-more]")).toHaveText("+3");
      await six.scrollIntoViewIfNeeded();
      await shot("6-header-six");
      await six.getByRole("button").hover();
      await expect(page.getByRole("tooltip")).toBeVisible();
      await shot("7-header-six-hover");
      await page.mouse.move(0, 0);

      // A plain reply tells four agents: faces and one summary in the header.
      await thread.getByLabel("Reply", { exact: true }).fill("Thanks, ship it");
      await thread.getByRole("button", { name: "Reply", exact: true }).click();
      const faces = thread.locator("[data-delivery-faces]").last();
      await expect(faces).toBeVisible();
      await expect(faces.locator("[data-summary]")).toHaveText("2 of 4");
      await faces.scrollIntoViewIfNeeded();
      await shot("3-header-four");
      await faces.getByRole("button").hover();
      await expect(page.getByRole("tooltip")).toBeVisible();
      await shot("4-faces-hover");

      // Two agents left: two faces and two ticks.
      await page.mouse.move(0, 0);
      for (const name of ["OA Product", "Claude Code"]) {
        await thread
          .getByRole("button", { name: `Stop notifying ${name}` })
          .click();
      }
      await thread.getByLabel("Reply", { exact: true }).fill("One more thing");
      await thread.getByRole("button", { name: "Reply", exact: true }).click();
      const two = thread.locator("[data-delivery-faces]").last();
      await expect(two.locator("[data-avatar]")).toHaveCount(2);
      await two.scrollIntoViewIfNeeded();
      await shot("5-header-two");
    });
