// The top of a comment lists every agent it notified (the @-mentioned ones first, then the
// thread agents), and a just-sent queued notice reads "sending" until the comment is 30s old.
// NOTIFY_HEADER_SHOTS_DIR picks where the PNGs go.
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.NOTIFY_HEADER_SHOTS_DIR;

async function open(page: Page) {
  await page.clock.install();
  await page.goto(`/a/${ID}?mock=agents`);
  await page.getByRole("button", { name: /^Comments/ }).click();
  await page
    .getByRole("button", { name: /^Show (in page|pin)/ })
    .first()
    .click();
}

for (const width of [1280, 390])
  for (const theme of ["light", "dark"] as const)
    test(`notify header at ${width}px ${theme}`, async ({ page }) => {
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

      // A seeded comment: an @ mention plus thread agents, aged past 30s.
      await open(page);
      await page.clock.fastForward(31_000);
      const thread = page.locator("li[data-thread]").filter({
        hasText: "Can the pricing section be shorter?",
      });
      await thread.getByRole("button", { name: /^Show (in page|pin)/ }).click();
      const fold = thread.getByRole("button", {
        name: /Show \d+ earlier replies/,
      });
      if (await fold.count()) await fold.first().click();
      // The "Looping in" comment @-mentions three agents and told two more thread agents.
      const root = thread
        .locator("[data-comment]")
        .filter({ hasText: "Looping in" });
      const faces = root.locator("[data-delivery-faces]");
      await expect(faces).toBeVisible();
      await faces.scrollIntoViewIfNeeded();
      await faces.getByRole("button").hover();
      const tip = page.getByRole("tooltip");
      await expect(tip).toBeVisible();
      await expect(tip).toContainText("held until it's back");
      await shot("1-mention-plus-thread-hover");
      await page.mouse.move(0, 0);

      // A just-sent comment that mentions an away agent: "sending", not held.
      const box = page.getByRole("textbox", { name: /Comment on/ }).first();
      await box.click();
      await box.pressSequentially("@Codex");
      await page.keyboard.press("Enter");
      await box.pressSequentially(" take a look");
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      const sent = page
        .locator("[data-comment]")
        .filter({ hasText: "take a look" })
        .first();
      const sending = sent.locator("[data-delivery-faces]");
      await expect(sending.locator('[data-mark="sending"]')).toBeVisible();
      await sending.getByRole("button").hover();
      await expect(page.getByRole("tooltip")).toContainText("Codex: sending");
      await shot("2-just-sent-sending");
      await page.mouse.move(0, 0);

      // 30s later it is held.
      await page.clock.fastForward(31_000);
      await expect(sending.locator('[data-mark="wait"]')).toBeVisible();
    });
