// #2174: the participants group at the top of a thread (mock=agents), closed,
// open, after a removal, and the signed-out view. PARTICIPANTS_SHOTS_DIR picks where the PNGs go.
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const ID = "Cd5fGhJkLm6nPqRs"; // Landing page
const OUT = process.env.PARTICIPANTS_SHOTS_DIR;

async function openComments(page: Page, mock: string, w: number) {
  await page.goto(
    `/a/${ID}?mock=${mock}${w < 600 ? "" : "&panel=open&tab=comments"}`,
  );
  if (w < 600) await page.getByRole("button", { name: /^Comments/ }).click();
}

for (const w of [1280, 390])
  for (const theme of ["light", "dark"] as const) {
    test(`participants ${w} ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: w, height: w < 600 ? 844 : 900 });
      if (OUT) mkdirSync(OUT, { recursive: true });
      const shot = async (name: string) => {
        if (OUT)
          await page.screenshot({ path: `${OUT}/${name}-${w}-${theme}.png` });
      };
      await openComments(page, "agents", w);
      const card = page
        .locator("li[data-thread]")
        .filter({ hasText: "Can the pricing section be shorter?" });
      const trig = card.locator("[data-participants-trigger]");
      await expect(trig).toBeVisible();
      await shot("1-closed");

      if (w >= 600) await trig.hover();
      else await trig.click();
      const list = card.locator("[data-participants-list]");
      await expect(list).toBeVisible();
      // The list floats: the thread does not grow.
      await shot("2-open");

      await list
        .getByRole("button", {
          name: "Stop notifying OA Product in this thread",
        })
        .click();
      await expect(
        list.getByText(/Remove OA Product from this thread\?/),
      ).toBeVisible();
      await list.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(list.locator("[data-off]")).toContainText("Not notified");
      await expect(
        list.getByText(/won't get replies in this thread/),
      ).toBeVisible();
      await shot("3-removed");
      // Close and reopen: the removed agent stays listed, with Add back.
      await page.keyboard.press("Escape");
      await expect(list).toBeHidden();
      await trig.focus();
      await expect(list).toBeVisible();
      await expect(list.locator("[data-off]")).toContainText("Not notified");
      await expect(list.locator("[data-add-back]")).toBeVisible();
      await shot("3b-reopened");

      await page.keyboard.press("Escape");
      await page.mouse.move(5, 5);
      await expect(list).toBeHidden();
      // A thread with one person and one agent, and one with nine participants.
      for (const [name, text] of [
        ["5-one-person-one-agent", "Solo note"],
        ["6-nine-participants", "Nine-person review"],
      ] as const) {
        const c = page.locator("li[data-thread]").filter({ hasText: text });
        const t = c.locator("[data-participants-trigger]");
        await t.scrollIntoViewIfNeeded();
        if (w >= 600) await t.hover();
        else await t.click();
        await expect(c.locator("[data-participants-list]")).toBeVisible();
        await shot(name);
        // A hover has no focus in the group, so Escape would reach the panel: move away instead.
        if (w >= 600) await page.mouse.move(5, 5);
        else await page.keyboard.press("Escape");
        await expect(c.locator("[data-participants-list]")).toBeHidden();
      }

      await page.goto(
        `/a/${ID}?mock=signed-out${w < 600 ? "" : "&panel=open&tab=comments"}`,
      );
      if (w < 600)
        await page.getByRole("button", { name: /^Comments/ }).click();
      const g = page.locator("[data-participants-trigger]").first();
      await expect(g).toBeVisible();
      if (w >= 600) await g.hover();
      else await g.click();
      await expect(
        page.locator("[data-participants-list]").first(),
      ).toBeVisible();
      await expect(page.locator("[data-participant-agent]")).toHaveCount(0);
      await shot("4-guest");
    });
  }

// A close crop of the closed pill at 3x, to check the overlap and the rings.
test.describe("pill crop", () => {
  test.use({ deviceScaleFactor: 3 });
  for (const theme of ["light", "dark"] as const)
    test(`pill 1280 ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: 1280, height: 900 });
      await openComments(page, "agents", 1280);
      const trig = page
        .locator("li[data-thread]")
        .filter({ hasText: "Can the pricing section be shorter?" })
        .locator("[data-participants-trigger]");
      await expect(trig).toBeVisible();
      if (!OUT) return;
      mkdirSync(OUT, { recursive: true });
      const b = await trig.boundingBox();
      if (!b) throw new Error("no pill");
      await page.screenshot({
        path: `${OUT}/7-pill-1280-${theme}.png`,
        clip: {
          x: b.x - 70,
          y: b.y - 8,
          width: b.width + 80,
          height: b.height + 16,
        },
      });
    });
});

// The pill of the nine-participant thread (three people shown), a 3x crop.
test.describe("nine pill crop", () => {
  test.use({ deviceScaleFactor: 3 });
  test("nine pill 1280 light", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await openComments(page, "agents", 1280);
    const trig = page
      .locator("li[data-thread]")
      .filter({ hasText: "Nine-person review" })
      .locator("[data-participants-trigger]");
    await trig.scrollIntoViewIfNeeded();
    await expect(trig).toBeVisible();
    if (!OUT) return;
    mkdirSync(OUT, { recursive: true });
    const b = await trig.boundingBox();
    if (!b) throw new Error("no pill");
    await page.screenshot({
      path: `${OUT}/8-nine-pill-1280-light.png`,
      clip: {
        x: b.x - 70,
        y: b.y - 8,
        width: b.width + 80,
        height: b.height + 16,
      },
    });
  });
});
