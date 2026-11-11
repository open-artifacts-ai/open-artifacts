// #2035: the reply box's "Notifying" chips (mock=agents), eight states at 1280 light and 390 dark.
// THREAD_AGENTS_SHOTS_DIR picks where the PNGs go.
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.THREAD_AGENTS_SHOTS_DIR;

async function open(page: Page) {
  await page.goto(`/a/${ID}?mock=agents`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  await page
    .locator("li[data-thread]")
    .filter({ hasText: "Can the pricing section be shorter?" })
    .getByRole("button", { name: /\d+ replies/ })
    .click();
  await expect(page.locator("[data-thread-agents]")).toBeVisible();
}

for (const [width, theme] of [
  [1280, "light"],
  [390, "dark"],
] as const)
  test(`thread agents at ${width}px ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height: 900 });
    if (OUT) mkdirSync(OUT, { recursive: true });
    await open(page);
    const box = page.locator("[data-thread-agents]");
    const shot = async (name: string) => {
      if (OUT)
        await page.screenshot({ path: `${OUT}/${name}-${width}-${theme}.png` });
    };
    await shot("1-default");

    const x = page.getByRole("button", { name: "Stop notifying OA Product" });
    await x.hover();
    await shot("2-hover");

    await x.click();
    await expect(
      box.getByText(/Remove OA Product from this thread\?/),
    ).toBeVisible();
    await shot("3-confirm");

    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(
      box.getByText(/OA Product won't get replies in this thread/),
    ).toBeVisible();
    await shot("4-removed");
    await box.getByRole("button", { name: "Undo" }).click();
    await expect(
      box.locator('[data-thread-agent="agent:product"]'),
    ).toBeVisible();

    await shot("5-overflow");
    await box.getByRole("button", { name: /more notified/ }).click();
    await expect(
      box.locator('[data-thread-agent="agent:polish"]'),
    ).toBeVisible();
    await shot("6-expanded");

    await box.locator('[data-thread-agent="agent:bus"]').hover();
    await shot("7-view-only");

    const card = page.locator("li[data-thread]").filter({ has: box });
    await card
      .getByLabel("Reply", { exact: true })
      .fill("Thanks, also fix the footer link");
    await card.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(page.locator("[data-notified]").first()).toBeVisible();
    await shot("8-delivery");
  });
