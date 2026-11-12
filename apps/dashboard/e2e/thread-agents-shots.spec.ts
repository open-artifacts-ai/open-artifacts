// #2035: the reply box's "Notifying" chips (mock=agents), eight states at 1280 light and 390 dark.
// THREAD_AGENTS_SHOTS_DIR picks where the PNGs go.
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.THREAD_AGENTS_SHOTS_DIR;

async function open(page: Page, text: string) {
  await page.goto(`/a/${ID}?mock=agents`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  await page
    .locator("li[data-thread]")
    .filter({ hasText: text })
    // #2179: no "N replies" button any more; selecting the thread (its
    // quote) opens it, as a reader does.
    .getByRole("button", { name: /^Show (in page|pin)/ })
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
    const shot = async (name: string) => {
      if (OUT)
        await page.screenshot({ path: `${OUT}/${name}-${width}-${theme}.png` });
    };
    // A thread with one agent: no overflow.
    await open(page, "Can you check the footer link?");
    const one = page.locator("[data-thread-agents]");
    await expect(
      one.getByRole("button", { name: /more notified/ }),
    ).toHaveCount(0);
    await shot("1-default");
    const hov = page.getByRole("button", { name: "Stop notifying OA Product" });
    await hov.hover();
    await expect(page.getByRole("tooltip")).toHaveText(
      "Stop notifying OA Product in this thread",
    );
    await shot("2-hover");

    await open(page, "Can the pricing section be shorter?");
    const box = page.locator("[data-thread-agents]");
    // One line: no chip wraps below the first row.
    const tops = await box
      .locator("[data-thread-agent]")
      .evaluateAll((els) =>
        els.map((e) => Math.round(e.getBoundingClientRect().top)),
      );
    expect(new Set(tops).size).toBe(1);
    const x = page.getByRole("button", { name: "Stop notifying OA Product" });
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
    await expect(page.getByRole("tooltip")).toContainText("whose agent it is");
    await shot("7-view-only");

    const card = page.locator("li[data-thread]").filter({ has: box });
    await card
      .getByLabel("Reply", { exact: true })
      .fill("Thanks, also fix the footer link");
    await card.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(page.locator("[data-notified]").first()).toBeVisible();
    await shot("8-delivery");
  });
